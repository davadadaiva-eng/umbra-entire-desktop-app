//! Device identity — Ed25519 signing keypair with a derived X25519 static key.
//!
//! Security model:
//! - The 32-byte seed is the *root secret* of the device. It lives inside the
//!   host OS keystore: DPAPI / Windows Credential Manager on Windows, Keychain
//!   on macOS (via the `keyring` crate — hardware/TPM-backed where available).
//! - From the seed we derive **two** Curve25519-family keys, so one root secret
//!   yields both signature and ECDH capabilities without unsafe ed↔x25519
//!   conversions:
//!   - `ed25519` keypair — signing identity, `device_id` derivation,
//!   - `x25519` static key — `x_priv = SHA256(seed ‖ "umbra-x25519-v1")`,
//!     used for the pairing ECDH and (later) Noise static keys.
//! - `device_id` is the immutable SHA-256 of `umbra-node-v1:<pub>` (base64),
//!   hex-encoded: `device_id = SHA256("umbra-node-v1:" ‖ base64(ed_pub))`.

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use ed25519_dalek::{Signature, Signer, SigningKey};
use rand_core::{OsRng, RngCore};
use sha2::{Digest, Sha256};
use std::fs;
use std::path::PathBuf;
use thiserror::Error;
use x25519_dalek::{PublicKey, StaticSecret};

/// Prefix used when deriving the immutable `device_id`.
pub const IDENTITY_PREFIX: &str = "umbra-node-v1:";
/// Keyring service name for Umbra Mesh credentials.
pub const KEYRING_SERVICE: &str = "umbra-mesh";
/// Domain-separation tag for the derived X25519 static secret.
pub const X25519_DERIVE_TAG: &[u8] = b"umbra-x25519-v1";

#[derive(Debug, Error)]
pub enum IdentityError {
    #[error("keystore failure: {0}")]
    Keystore(#[from] KeyStoreError),
    #[error("seed material has wrong length: {0}")]
    BadSeed(#[from] std::array::TryFromSliceError),
    #[error("invalid ed25519 key material: {0}")]
    Ed25519(#[from] ed25519_dalek::SignatureError),
    #[error("invalid base64: {0}")]
    Base64(#[from] base64::DecodeError),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
}

#[derive(Debug, Error)]
pub enum KeyStoreError {
    #[error("os keystore error: {0}")]
    Os(String),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
}

/// Abstraction over where the root seed is persisted.
/// Production uses [`OsKeyStore`] (DPAPI/Keychain); tests and headless hosts
/// use [`FileKeyStore`].
pub trait KeyStore: Send + Sync {
    fn load_seed(&self, service: &str, user: &str) -> Result<Option<[u8; 32]>, KeyStoreError>;
    fn store_seed(&self, service: &str, user: &str, seed: &[u8; 32]) -> Result<(), KeyStoreError>;
}

/// OS-backed store via `keyring` (Windows Credential Manager/DPAPI,
/// macOS Keychain, Linux Secret Service).
pub struct OsKeyStore;

impl KeyStore for OsKeyStore {
    fn load_seed(&self, service: &str, user: &str) -> Result<Option<[u8; 32]>, KeyStoreError> {
        let entry = keyring::Entry::new(service, user).map_err(|e| KeyStoreError::Os(e.to_string()))?;
        let Ok(raw) = entry.get_password() else {
            return Ok(None);
        };
        let hex = raw.trim();
        if hex.len() != 64 {
            return Err(KeyStoreError::Os(format!("stored seed has invalid length: {}", hex.len())));
        }
        let mut seed = [0u8; 32];
        for i in 0..32 {
            seed[i] = u8::from_str_radix(&hex[2 * i..2 * i + 2], 16)
                .map_err(|e| KeyStoreError::Os(format!("stored seed is not hex: {e}")))?;
        }
        Ok(Some(seed))
    }

    fn store_seed(&self, service: &str, user: &str, seed: &[u8; 32]) -> Result<(), KeyStoreError> {
        let entry = keyring::Entry::new(service, user).map_err(|e| KeyStoreError::Os(e.to_string()))?;
        let hex = seed.iter().map(|b| format!("{b:02x}")).collect::<String>();
        entry
            .set_password(&hex)
            .map_err(|e| KeyStoreError::Os(format!("store failed: {e}")))?;
        Ok(())
    }
}

/// Plain-file fallback store (`0600` permissions). Not hardware-backed;
/// only intended for headless/testing environments.
pub struct FileKeyStore {
    dir: PathBuf,
}

impl FileKeyStore {
    pub fn new(dir: impl Into<PathBuf>) -> Self {
        Self { dir: dir.into() }
    }

    fn path_for(&self, service: &str, user: &str) -> PathBuf {
        self.dir.join(format!("{service}-{user}.seed"))
    }
}

impl KeyStore for FileKeyStore {
    fn load_seed(&self, service: &str, user: &str) -> Result<Option<[u8; 32]>, KeyStoreError> {
        let p = self.path_for(service, user);
        if !p.exists() {
            return Ok(None);
        }
        let raw = fs::read_to_string(&p)?;
        let hex = raw.trim();
        if hex.len() != 64 {
            return Err(KeyStoreError::Io(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                format!("seed file {} has invalid length {}", p.display(), hex.len()),
            )));
        }
        let mut seed = [0u8; 32];
        for i in 0..32 {
            seed[i] = u8::from_str_radix(&hex[2 * i..2 * i + 2], 16)
                .map_err(|e| KeyStoreError::Io(std::io::Error::new(std::io::ErrorKind::InvalidData, e)))?;
        }
        Ok(Some(seed))
    }

    fn store_seed(&self, service: &str, user: &str, seed: &[u8; 32]) -> Result<(), KeyStoreError> {
        fs::create_dir_all(&self.dir)?;
        let p = self.path_for(service, user);
        let hex = seed.iter().map(|b| format!("{b:02x}")).collect::<String>();
        fs::write(&p, hex)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&p, fs::Permissions::from_mode(0o600))?;
        }
        Ok(())
    }
}

/// Immutable device identity. Private material zeroizes on drop
/// (via `SigningKey` / `StaticSecret` inner zeroize-on-drop).
pub struct Identity {
    name: String,
    signing: SigningKey,
    x_static: StaticSecret,
}

impl Identity {
    /// Rebuild identity from a root seed.
    pub fn from_seed(seed: [u8; 32], name: impl Into<String>) -> Self {
        let x_seed = derive_x25519_seed(&seed);
        Self {
            name: name.into(),
            signing: SigningKey::from_bytes(&seed),
            x_static: StaticSecret::from(x_seed),
        }
    }

    /// Load the identity from the given store, generating and persisting a
    /// fresh root seed on first boot. Returns `(identity, created)`.
    pub fn load_or_create(store: &dyn KeyStore, name: &str) -> Result<(Self, bool), IdentityError> {
        let user = keyring_user(name);
        if let Some(seed) = store.load_seed(KEYRING_SERVICE, &user)? {
            tracing::info!(user, "identity loaded from keystore");
            return Ok((Self::from_seed(seed, name), false));
        }
        let mut seed = [0u8; 32];
        OsRng.fill_bytes(&mut seed);
        store.store_seed(KEYRING_SERVICE, &user, &seed)?;
        tracing::info!(user, "identity generated and stored in keystore");
        Ok((Self::from_seed(seed, name), true))
    }

    pub fn name(&self) -> &str {
        &self.name
    }

    /// Raw 32-byte Ed25519 public key.
    pub fn ed25519_pub(&self) -> [u8; 32] {
        self.signing.verifying_key().to_bytes()
    }

    /// Base64 of the raw Ed25519 public key (the `pub` QR field).
    pub fn ed25519_pub_b64(&self) -> String {
        B64.encode(self.ed25519_pub())
    }

    /// X25519 static public key (the `xp` QR field).
    pub fn x25519_pub(&self) -> PublicKey {
        PublicKey::from(&self.x_static)
    }

    pub fn x25519_pub_bytes(&self) -> [u8; 32] {
        self.x25519_pub().to_bytes()
    }

    pub fn x25519_pub_b64(&self) -> String {
        B64.encode(self.x25519_pub_bytes())
    }

    pub fn x_secret(&self) -> &StaticSecret {
        &self.x_static
    }

    /// Immutable device identifier:
    /// `SHA256("umbra-node-v1:" ‖ base64(ed_pub))`, hex-encoded.
    pub fn device_id(&self) -> String {
        device_id_for_pub(&self.ed25519_pub_b64())
    }

    /// Sign a message with the Ed25519 identity key.
    pub fn sign(&self, msg: &[u8]) -> Signature {
        self.signing.sign(msg)
    }
}

/// Derive the immutable device_id for a base64 Ed25519 public key.
pub fn device_id_for_pub(ed_pub_b64: &str) -> String {
    let mut h = Sha256::new();
    h.update(IDENTITY_PREFIX.as_bytes());
    h.update(ed_pub_b64.as_bytes());
    let d = h.finalize();
    d.iter().map(|b| format!("{b:02x}")).collect()
}

fn derive_x25519_seed(seed: &[u8; 32]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(seed);
    h.update(X25519_DERIVE_TAG);
    h.finalize().into()
}

fn keyring_user(name: &str) -> String {
    let sanitized: String = name
        .chars()
        .map(|c| if c.is_alphanumeric() || c == '-' || c == '_' { c } else { '-' })
        .collect();
    format!("device:{sanitized}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::VerifyingKey;
    use std::path::Path;

    fn temp_store(dir: &Path) -> FileKeyStore {
        FileKeyStore::new(dir)
    }

    #[test]
    fn creates_then_reloads_identity() {
        let dir = std::env::temp_dir().join(format!("umbra-id-test-{}", uuid_like()));
        let store = temp_store(&dir);
        let (id, created) = Identity::load_or_create(&store, "Test Rig").unwrap();
        assert!(created, "first boot must create");
        let id2 = Identity::load_or_create(&store, "Test Rig").unwrap();
        assert!(!id2.1, "second boot must load");
        assert_eq!(id.device_id(), id2.0.device_id(), "device_id must be stable");
        assert_eq!(id.ed25519_pub_b64(), id2.0.ed25519_pub_b64());
        assert_eq!(id.x25519_pub_b64(), id2.0.x25519_pub_b64());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn device_id_is_sha256_of_prefixed_pub() {
        let dir = std::env::temp_dir().join(format!("umbra-id-test2-{}", uuid_like()));
        let store = temp_store(&dir);
        let (id, _) = Identity::load_or_create(&store, "Test").unwrap();
        let mut h = Sha256::new();
        h.update(IDENTITY_PREFIX.as_bytes());
        h.update(id.ed25519_pub_b64().as_bytes());
        let expect: String = h.finalize().iter().map(|b| format!("{b:02x}")).collect();
        assert_eq!(id.device_id(), expect);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn signature_verifies() {
        let dir = std::env::temp_dir().join(format!("umbra-id-test3-{}", uuid_like()));
        let store = temp_store(&dir);
        let (id, _) = Identity::load_or_create(&store, "Test").unwrap();
        let msg = b"hello mesh";
        let sig = id.sign(msg);
        let vk = VerifyingKey::from_bytes(&id.ed25519_pub()).unwrap();
        assert!(vk.verify_strict(msg, &sig).is_ok());
        assert!(vk.verify_strict(b"tampered", &sig).is_err());
        let _ = fs::remove_dir_all(&dir);
    }

    fn uuid_like() -> String {
        use rand_core::RngCore;
        let mut b = [0u8; 8];
        OsRng.fill_bytes(&mut b);
        b.iter().map(|x| format!("{x:02x}")).collect()
    }
}
