//! Umbra Mesh — core library.
//!
//! Zero-trust, identity-sovereign P2P engine:
//! - [`crypto::identity`] — Ed25519 device identity + derived X25519 static key,
//!   private material in the OS keystore (DPAPI / Keychain) or file fallback.
//! - [`crypto::pairing`] — zero-knowledge local pairing (signed QR payloads,
//!   Curve25519 ECDH, HKDF session keys).
//! - [`db`] — SQLite pairing store (`mesh_devices`).

pub mod crypto;
pub mod db;

pub use crypto::identity::{Identity, IdentityError, KeyStore, KeyStoreError, OsKeyStore, FileKeyStore};
pub use crypto::pairing::{
    client_session_key, create_signed_pairing, desktop_session_key, kdf_session_key,
    new_ephemeral, render_qr_ascii, verify_signed, PairingError, PairingPayload, SignedPairing,
    VerifiedPeer, DEFAULT_TTL_SECS, PAIRING_VERSION,
};
pub use db::{DbError, DeviceRow, MeshDb};
