//! SQLite persistence for paired devices.
//!
//! `mesh_devices` table (schema per the Umbra Mesh contract, with two
//! additions: `x_public_key` for the ECDH static key, and `created_at`):
//!
//! ```sql
//! CREATE TABLE IF NOT EXISTS mesh_devices (
//!   device_id        TEXT PRIMARY KEY,
//!   device_name      TEXT NOT NULL,
//!   device_type      TEXT CHECK(device_type IN ('mobile','tablet','wearable','desktop')),
//!   public_key       TEXT NOT NULL,           -- ed25519 b64
//!   x_public_key     TEXT NOT NULL,           -- x25519 static b64
//!   permission_level TEXT CHECK(permission_level IN ('admin','monitor','compute','standard'))
//!                    DEFAULT 'standard',
//!   last_seen_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
//!   created_at       DATETIME DEFAULT CURRENT_TIMESTAMP
//! );
//! ```
//!
//! Note: the enforcement `CHECK` must include `'standard'` to satisfy the
//! contract's `DEFAULT 'standard'` (an `IN ('admin','monitor','compute')`
//! check combined with a `'standard'` default would reject every default row).

use std::path::Path;
use thiserror::Error;

use rusqlite::{params, Connection, OptionalExtension};

#[derive(Debug, Error)]
pub enum DbError {
    #[error("sqlite error: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
}

/// A device being inserted or refreshed after pairing.
#[derive(Debug, Clone)]
pub struct NewDevice {
    pub device_id: String,
    pub device_name: String,
    pub device_type: String,
    pub public_key: String,
    pub x_public_key: String,
    pub permission_level: String,
}

#[derive(Debug, Clone)]
pub struct DeviceRow {
    pub device_id: String,
    pub device_name: String,
    pub device_type: String,
    pub public_key: String,
    pub x_public_key: String,
    pub permission_level: String,
    pub last_seen_at: String,
    pub created_at: String,
}

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS mesh_devices (
  device_id        TEXT PRIMARY KEY,
  device_name      TEXT NOT NULL,
  device_type      TEXT CHECK(device_type IN ('mobile','tablet','wearable','desktop')),
  public_key       TEXT NOT NULL,
  x_public_key     TEXT NOT NULL,
  permission_level TEXT CHECK(permission_level IN ('admin','monitor','compute','standard'))
                   DEFAULT 'standard',
  last_seen_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
  created_at       DATETIME DEFAULT CURRENT_TIMESTAMP
);
"#;

pub struct MeshDb {
    conn: Connection,
}

impl MeshDb {
    pub fn open(path: &Path) -> Result<Self, DbError> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let conn = Connection::open(path)?;
        Self::init(conn)
    }

    pub fn in_memory() -> Result<Self, DbError> {
        Self::init(Connection::open_in_memory()?)
    }

    fn init(conn: Connection) -> Result<Self, DbError> {
        conn.pragma_update(None, "journal_mode", "WAL").ok();
        conn.execute_batch(SCHEMA)?;
        let version: i64 = conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap_or(0);
        if version < 1 {
            conn.pragma_update(None, "user_version", 1)?;
        }
        Ok(Self { conn })
    }

    /// Insert a freshly-paired device. Re-pairing refreshes name/type and
    /// `last_seen_at` but never overwrites an existing `permission_level`
    /// (privileges change only through explicit policy).
    pub fn insert_device(&mut self, peer: &NewDevice) -> Result<(), DbError> {
        self.conn.execute(
            "INSERT INTO mesh_devices \
                (device_id, device_name, device_type, public_key, x_public_key, permission_level) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6) \
             ON CONFLICT(device_id) DO UPDATE SET \
               device_name  = excluded.device_name, \
               device_type  = excluded.device_type, \
               last_seen_at = CURRENT_TIMESTAMP",
            params![
                peer.device_id,
                peer.device_name,
                peer.device_type,
                peer.public_key,
                peer.x_public_key,
                peer.permission_level,
            ],
        )?;
        Ok(())
    }

    pub fn list_devices(&self) -> Result<Vec<DeviceRow>, DbError> {
        let mut stmt = self.conn.prepare(
            "SELECT device_id, device_name, device_type, public_key, x_public_key, \
                   permission_level, last_seen_at, created_at \
             FROM mesh_devices ORDER BY created_at ASC",
        )?;
        let rows = stmt.query_map([], row_from)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    pub fn get_device(&self, device_id: &str) -> Result<Option<DeviceRow>, DbError> {
        self.conn
            .query_row(
                "SELECT device_id, device_name, device_type, public_key, x_public_key, \
                       permission_level, last_seen_at, created_at \
                 FROM mesh_devices WHERE device_id = ?1",
                params![device_id],
                row_from,
            )
            .optional()
            .map_err(Into::into)
    }

    pub fn revoke_device(&mut self, device_id: &str) -> Result<bool, DbError> {
        let n = self
            .conn
            .execute("DELETE FROM mesh_devices WHERE device_id = ?1", params![device_id])?;
        Ok(n > 0)
    }

    pub fn touch_device(&mut self, device_id: &str) -> Result<(), DbError> {
        self.conn.execute(
            "UPDATE mesh_devices SET last_seen_at = CURRENT_TIMESTAMP WHERE device_id = ?1",
            params![device_id],
        )?;
        Ok(())
    }

    pub fn count(&self) -> Result<i64, DbError> {
        let n: i64 = self.conn.query_row("SELECT COUNT(*) FROM mesh_devices", [], |r| r.get(0))?;
        Ok(n)
    }
}

fn row_from(r: &rusqlite::Row<'_>) -> rusqlite::Result<DeviceRow> {
    Ok(DeviceRow {
        device_id: r.get(0)?,
        device_name: r.get(1)?,
        device_type: r.get(2)?,
        public_key: r.get(3)?,
        x_public_key: r.get(4)?,
        permission_level: r.get(5)?,
        last_seen_at: r.get(6)?,
        created_at: r.get(7)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn peer(id: &str) -> NewDevice {
        NewDevice {
            device_id: id.to_string(),
            device_name: "Kitchen Tablet".to_string(),
            device_type: "tablet".to_string(),
            public_key: "AAA".to_string(),
            x_public_key: "BBB".to_string(),
            permission_level: "standard".to_string(),
        }
    }

    #[test]
    fn insert_list_touch_revoke() {
        let mut db = MeshDb::in_memory().unwrap();
        db.insert_device(&peer("dev-1")).unwrap();
        db.insert_device(&peer("dev-2")).unwrap();

        assert_eq!(db.list_devices().unwrap().len(), 2);

        let row = db.get_device("dev-1").unwrap().expect("must exist");
        assert_eq!(row.device_name, "Kitchen Tablet");
        assert_eq!(row.permission_level, "standard");
        assert!(!row.last_seen_at.is_empty());

        db.touch_device("dev-1").unwrap();
        assert!(db.revoke_device("dev-1").unwrap());
        assert!(!db.revoke_device("dev-1").unwrap());
        assert!(db.get_device("dev-1").unwrap().is_none());
        assert_eq!(db.count().unwrap(), 1);
    }

    #[test]
    fn re_pair_keeps_permission_and_updates_name() {
        let mut db = MeshDb::in_memory().unwrap();
        db.insert_device(&peer("dev-1")).unwrap();

        let mut upgraded = peer("dev-1");
        upgraded.permission_level = "admin".to_string();
        upgraded.device_name = "Living Room".to_string();
        db.insert_device(&upgraded).unwrap();

        let row = db.get_device("dev-1").unwrap().unwrap();
        assert_eq!(row.device_name, "Living Room");
        // First pairing set 'standard'; re-pairing must NOT upgrade privilege.
        assert_eq!(row.permission_level, "standard");
    }

    #[test]
    fn schema_rejects_unknown_device_type() {
        let mut db = MeshDb::in_memory().unwrap();
        let mut p = peer("dev-3");
        p.device_type = "toaster".to_string();
        assert!(db.insert_device(&p).is_err());
    }

    #[test]
    fn open_creates_file_and_dir() {
        let dir = std::env::temp_dir().join("umbra-db-test");
        let path = dir.join("mesh.db");
        let _ = std::fs::remove_dir_all(&dir);
        let mut db = MeshDb::open(&path).unwrap();
        db.insert_device(&peer("dev-9")).unwrap();
        drop(db);
        // re-open and read back
        let db = MeshDb::open(&path).unwrap();
        assert_eq!(db.count().unwrap(), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
