//! `umbra-meshd` — the Umbra Mesh daemon.
//!
//! Speaks newline-delimited JSON-RPC 2.0 over **stdin/stdout** (logs go to
//! stderr). The TypeScript host (`mesh/ts`) spawns this process and drives it.
//!
//! Example:
//! ```text
//! --> {"jsonrpc":"2.0","id":1,"method":"mesh.status","params":{}}
//! <-- {"jsonrpc":"2.0","id":1,"result":{...}}
//! ```
//!
//! - One JSON object per line; requests carry an `id`.
//! - Responses: `{"jsonrpc":"2.0","id":N,"result":{...}}` or
//!   `{"jsonrpc":"2.0","id":N,"error":{"code":<int>,"message":"..."}}`.
//! - Events are notifications without `id` (reserved for M2+).

use std::io::{BufRead, Write};
use std::path::PathBuf;
use std::process::ExitCode;
use std::time::{SystemTime, UNIX_EPOCH};

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use rand_core::RngCore;
use serde_json::{json, Value};
use umbra_mesh::crypto::identity::{FileKeyStore, Identity, OsKeyStore};
use umbra_mesh::db::{self as mesh_db, MeshDb};
use umbra_mesh::{
    client_session_key, create_signed_pairing, desktop_session_key, new_ephemeral,
    render_qr_ascii, verify_signed, DbError, PairingError, SignedPairing, DEFAULT_TTL_SECS,
};

// ─────────────────────────────── config ───────────────────────────────

enum KeystoreKind {
    Os,
    File,
}

struct Cli {
    data_dir: PathBuf,
    keystore: KeystoreKind,
    name: String,
}

fn default_data_dir() -> PathBuf {
    if let Ok(d) = std::env::var("UMBRA_MESH_DIR") {
        return PathBuf::from(d);
    }
    let base = std::env::var("APPDATA").unwrap_or_else(|_| ".".into());
    PathBuf::from(base).join("umbra-mesh")
}

fn hostname() -> String {
    std::env::var("COMPUTERNAME").unwrap_or_else(|_| "umbra-host".into())
}

fn parse_args() -> Cli {
    let mut data_dir = default_data_dir();
    let mut keystore = KeystoreKind::Os;
    let mut name = hostname();
    let mut args = std::env::args().skip(1);
    while let Some(a) = args.next() {
        match a.as_str() {
            "--data-dir" => {
                if let Some(v) = args.next() {
                    data_dir = PathBuf::from(v);
                }
            }
            "--keystore" => {
                if let Some(v) = args.next() {
                    keystore = if v == "file" { KeystoreKind::File } else { KeystoreKind::Os };
                }
            }
            "--name" => {
                if let Some(v) = args.next() {
                    name = v;
                }
            }
            "--help" | "-h" => {
                eprintln!(
                    "umbra-meshd [--data-dir <path>] [--keystore os|file] [--name <name>]\n\
                     JSON-RPC 2.0 over stdio. Logs to stderr."
                );
                std::process::exit(0);
            }
            _ => {}
        }
    }
    Cli { data_dir, keystore, name }
}

// ─────────────────────────────── app state ───────────────────────────────

struct App {
    data_dir: PathBuf,
    keystore_kind: &'static str,
    db: MeshDb,
    identity: Identity,
    identity_created: bool,
}

fn init_app(cli: &Cli) -> Result<App, Box<dyn std::error::Error>> {
    std::fs::create_dir_all(&cli.data_dir)?;
    std::fs::create_dir_all(cli.data_dir.join("keys"))?;

    let mut keystore_kind = "os";
    let (identity, identity_created) = match cli.keystore {
        KeystoreKind::Os => {
            match Identity::load_or_create(&OsKeyStore, &cli.name) {
                Ok(v) => v,
                Err(e) => {
                    tracing::warn!(err = %e, "OS keystore unavailable; falling back to file store");
                    keystore_kind = "file";
                    Identity::load_or_create(&FileKeyStore::new(cli.data_dir.join("keys")), &cli.name)?
                }
            }
        }
        KeystoreKind::File => {
            keystore_kind = "file";
            Identity::load_or_create(&FileKeyStore::new(cli.data_dir.join("keys")), &cli.name)?
        }
    };

    let db = MeshDb::open(&cli.data_dir.join("mesh.db"))?;
    Ok(App {
        data_dir: cli.data_dir.clone(),
        keystore_kind,
        db,
        identity,
        identity_created,
    })
}

// ─────────────────────────────── JSON-RPC ───────────────────────────────

#[derive(Debug)]
enum RpcError {
    InvalidParams(String),
    Internal(String),
}

impl RpcError {
    fn code(&self) -> i64 {
        match self {
            RpcError::InvalidParams(_) => -32602,
            RpcError::Internal(_) => -32603,
        }
    }
    fn message(&self) -> &str {
        match self {
            RpcError::InvalidParams(m) | RpcError::Internal(m) => m,
        }
    }
}

impl From<PairingError> for RpcError {
    fn from(e: PairingError) -> Self {
        RpcError::Internal(e.to_string())
    }
}

impl From<DbError> for RpcError {
    fn from(e: DbError) -> Self {
        RpcError::Internal(e.to_string())
    }
}

impl From<serde_json::Error> for RpcError {
    fn from(e: serde_json::Error) -> Self {
        RpcError::Internal(e.to_string())
    }
}

fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn local_addrs() -> Vec<String> {
    local_ip_address::list_afinet_netifas()
        .map(|ifas| {
            ifas.into_iter()
                .filter_map(|(_, ip)| ip.is_ipv4().then(|| ip.to_string()))
                .collect()
        })
        .unwrap_or_default()
}

fn get_str<'a>(params: &'a Value, key: &str) -> Result<&'a str, RpcError> {
    params
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| RpcError::InvalidParams(format!("missing string param: {key}")))
}

fn get_i64(params: &Value, key: &str, default: i64) -> i64 {
    params.get(key).and_then(Value::as_i64).unwrap_or(default)
}

fn parse_wire(params: &Value) -> Result<SignedPairing, RpcError> {
    let s = get_str(params, "wire")?;
    serde_json::from_str(s).map_err(|e| RpcError::InvalidParams(format!("wire: {e}")))
}

fn status_json(app: &App) -> Value {
    let devices = app.db.count().unwrap_or(-1);
    json!({
        "ok": true,
        "proto": "umbra-mesh/v1",
        "version": env!("CARGO_PKG_VERSION"),
        "identity": {
            "name": app.identity.name(),
            "device_id": app.identity.device_id(),
            "ed_pub": app.identity.ed25519_pub_b64(),
            "xp": app.identity.x25519_pub_b64(),
            "created": app.identity_created,
        },
        "keystore": app.keystore_kind,
        "data_dir": app.data_dir.to_string_lossy(),
        "addrs": local_addrs(),
        "paired_devices": devices,
    })
}

fn handle_method(app: &mut App, method: &str, params: Value) -> Result<Value, RpcError> {
    match method {
        "mesh.status" => Ok(status_json(app)),

        "mesh.pair.create" => {
            let ttl = get_i64(&params, "ttl", DEFAULT_TTL_SECS);
            let wire = create_signed_pairing(&app.identity, &local_addrs(), ttl, now_secs())?;
            let qr_ascii = render_qr_ascii(&serde_json::to_string(&wire)?)?;
            Ok(json!({
                "device_id": app.identity.device_id(),
                "wire": wire,
                "exp": wire.payload.exp,
                "qr_ascii": qr_ascii,
            }))
        }

        "mesh.pair.verify" => {
            let wire = parse_wire(&params)?;
            let v = verify_signed(&wire, now_secs())?;
            Ok(json!({
                "ok": true,
                "device_id": v.device_id,
                "ed_pub": B64.encode(v.ed_pub),
                "xp": B64.encode(v.x_pub),
                "addrs": v.addrs,
                "exp": v.exp,
                "message": "signature valid; device_id bound to pub; not expired",
            }))
        }

        "mesh.pair.respond" => {
            // Desktop side, receiving a real secondary's reply.
            let wire = parse_wire(&params)?;
            let v = verify_signed(&wire, now_secs())?;

            let eph_pub_b64 = get_str(&params, "eph_pub")?;
            let eph_pub: [u8; 32] = B64
                .decode(eph_pub_b64)
                .map_err(|e| RpcError::InvalidParams(format!("eph_pub: {e}")))?
                .as_slice()
                .try_into()
                .map_err(|_| RpcError::InvalidParams("eph_pub must be 32 bytes".to_string()))?;

            let device_name = params
                .get("device_name")
                .and_then(Value::as_str)
                .unwrap_or("paired-device");
            let device_type = params
                .get("device_type")
                .and_then(Value::as_str)
                .unwrap_or("desktop");
            let permission = params
                .get("permission_level")
                .and_then(Value::as_str)
                .unwrap_or("standard");

            let session = desktop_session_key(&app.identity, &eph_pub, &v.x_pub);

            app.db.insert_device(&mesh_db::NewDevice {
                device_id: v.device_id.clone(),
                device_name: device_name.to_string(),
                device_type: device_type.to_string(),
                public_key: B64.encode(v.ed_pub),
                x_public_key: B64.encode(v.x_pub),
                permission_level: permission.to_string(),
            })?;

            Ok(json!({
                "ok": true,
                "device_id": v.device_id,
                "pairing": true,
                "session_key": B64.encode(session),
            }))
        }

        "mesh.pair.demo" => {
            // TEST/DEMO ONLY: exercises the complete handshake on one host —
            // desktop renders a QR, an in-process secondary validates it,
            // replies, and both sides derive the session key. The host must
            // prove `desktop_key == client_key` before trusting the pairing.
            let ttl = get_i64(&params, "ttl", DEFAULT_TTL_SECS);
            let desktop_qr = create_signed_pairing(&app.identity, &local_addrs(), ttl, now_secs())?;

            // Simulated secondary identity (random, ephemeral — not persisted).
            let mut seed = [0u8; 32];
            rand_core::OsRng.fill_bytes(&mut seed);
            let secondary = Identity::from_seed(seed, "simulated-client");
            let (eph_secret, eph_pub) = new_ephemeral();
            let sec_reply = create_signed_pairing(&secondary, &[], ttl, now_secs())?;

            // Desktop validates the reply and derives its session key.
            let v = verify_signed(&sec_reply, now_secs())?;
            let desktop_key = desktop_session_key(&app.identity, &eph_pub.to_bytes(), &v.x_pub);

            // Client derives from the QR (desktop static pub) + its own secrets.
            let desk_v = verify_signed(&desktop_qr, now_secs())?;
            let client_key = client_session_key(&eph_secret, secondary.x_secret(), &desk_v.x_pub);

            let matched = desktop_key == client_key;

            // Persist the simulated device so the row is inspectable.
            app.db.insert_device(&mesh_db::NewDevice {
                device_id: v.device_id.clone(),
                device_name: "Simulated Client".to_string(),
                device_type: "mobile".to_string(),
                public_key: B64.encode(v.ed_pub),
                x_public_key: B64.encode(v.x_pub),
                permission_level: "standard".to_string(),
            })?;

            Ok(json!({
                "ok": matched,
                "match": matched,
                "device_id": v.device_id,
                "desktop_session_key": B64.encode(desktop_key),
                "client_session_key": B64.encode(client_key),
                "message": if matched {
                    "session keys match — pairing channel verified"
                } else {
                    "session keys differ — handshake failed"
                },
            }))
        }

        "mesh.devices.list" => {
            let devices: Vec<Value> = app
                .db
                .list_devices()?
                .into_iter()
                .map(|d| {
                    json!({
                        "device_id": d.device_id,
                        "device_name": d.device_name,
                        "device_type": d.device_type,
                        "public_key": d.public_key,
                        "x_public_key": d.x_public_key,
                        "permission_level": d.permission_level,
                        "last_seen_at": d.last_seen_at,
                        "created_at": d.created_at,
                    })
                })
                .collect();
            Ok(json!({ "devices": devices }))
        }

        "mesh.devices.revoke" => {
            let device_id = get_str(&params, "device_id")?;
            let removed = app.db.revoke_device(device_id)?;
            Ok(json!({ "ok": removed, "device_id": device_id }))
        }

        other => Err(RpcError::Internal(format!("unknown method: {other}"))),
    }
}

// ─────────────────────────────── main loop ───────────────────────────────

fn main() -> ExitCode {
    tracing_subscriber::fmt()
        .with_writer(std::io::stderr)
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "umbra_mesh=info,umbra_meshd=info,warn".into()),
        )
        .init();

    let cli = parse_args();
    let app = match init_app(&cli) {
        Ok(a) => a,
        Err(e) => {
            eprintln!("fatal: {e}");
            return ExitCode::FAILURE;
        }
    };
    tracing::info!(
        device_id = %app.identity.device_id(),
        keystore = %app.keystore_kind,
        "umbra-meshd ready"
    );

    let mut app = app;
    let stdin = std::io::stdin();
    let mut out = std::io::stdout();

    for line in stdin.lock().lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => break, // stdin closed (host exited)
        };
        if line.trim().is_empty() {
            continue;
        }
        let parsed: Result<Value, _> = serde_json::from_str(&line);
        let request = match parsed {
            Ok(v) => v,
            Err(e) => {
                let resp = json!({ "jsonrpc": "2.0", "id": null, "error": { "code": -32700, "message": format!("parse error: {e}") } });
                let _ = out.write_all(resp.to_string().as_bytes()).and_then(|_| out.write_all(b"\n")).and_then(|_| out.flush());
                continue;
            }
        };

        let method = request.get("method").and_then(Value::as_str).unwrap_or("");
        let params = request.get("params").cloned().unwrap_or(Value::Null);
        let id = request.get("id").cloned().unwrap_or(Value::Null);

        let result = handle_method(&mut app, method, params);
        let resp = match result {
            Ok(r) => json!({ "jsonrpc": "2.0", "id": id, "result": r }),
            Err(e) => json!({ "jsonrpc": "2.0", "id": id, "error": { "code": e.code(), "message": e.message() } }),
        };
        if out
            .write_all(resp.to_string().as_bytes())
            .and_then(|_| out.write_all(b"\n"))
            .and_then(|_| out.flush())
            .is_err()
        {
            tracing::warn!("host closed stdout; exiting");
            break;
        }
    }

    ExitCode::SUCCESS
}
