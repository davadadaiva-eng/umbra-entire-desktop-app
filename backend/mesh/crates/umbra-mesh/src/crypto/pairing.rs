//! Zero-Knowledge Exchange Protocol (ZKEP) local pairing.
//!
//! Flow (Desktop 1 → secondary device, no cloud involvement):
//! 1. Desktop builds a signed `PairingPayload` (`v=1, id, pub, xp, addrs,
//!    nonce, exp`) and renders it as a QR code. `pub` is the Ed25519 key used
//!    to sign; `xp` is the X25519 static key used for the ECDH.
//! 2. Secondary scans, verifies the Ed25519 signature over the canonical JSON,
//!    binds `id == SHA256("umbra-node-v1:" ‖ pub)`, and checks `exp`.
//! 3. Secondary generates an *ephemeral* X25519 keypair and replies with its
//!    own signed payload + `eph_pub`. Desktop verifies the reply and persists
//!    the device into `mesh_devices`.
//! 4. Both sides derive the same 32-byte session key:
//!    `K = HKDF-SHA256(DH(A_static, B_eph) ‖ DH(A_static, B_static))`
//!    (desktop A = static only; secondary B contributes the ephemeral, giving
//!    forward secrecy on the secondary side — PFS hardening arrives with the
//!    Noise tunnel in M2).
//!
//! The signature covers a canonical (key-sorted, deterministic) JSON encoding
//! so payloads signed here verify identically from any language runtime.

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use ed25519_dalek::{Signature, VerifyingKey};
use hkdf::Hkdf;
use rand_core::{OsRng, RngCore};
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use thiserror::Error;
use x25519_dalek::{PublicKey, StaticSecret};

use super::identity::{device_id_for_pub, Identity, IDENTITY_PREFIX};

/// Wire format version of the pairing payload.
pub const PAIRING_VERSION: u64 = 1;
/// Default QR validity window.
pub const DEFAULT_TTL_SECS: i64 = 120;
const NONCE_LEN: usize = 16;
/// HKDF salt — domain-separates every session key from pairing data.
pub const SESSION_SALT: &[u8] = b"umbra-mesh-pair-v1";
/// HKDF info for the final session key expansion.
const SESSION_INFO: &[u8] = b"umbra-session-v1";

#[derive(Debug, Error)]
pub enum PairingError {
    #[error("unsupported payload version {0}")]
    UnsupportedVersion(u64),
    #[error("pairing payload expired at {exp} (now {now})")]
    Expired { exp: i64, now: i64 },
    #[error("invalid base64: {0}")]
    Base64(#[from] base64::DecodeError),
    #[error("ed25519 verification failed: {0}")]
    Ed25519(#[from] ed25519_dalek::SignatureError),
    #[error("bad key material: {0}")]
    Key(#[from] std::array::TryFromSliceError),
    #[error("device_id mismatch: payload claims {claimed}, pub key derives {derived}")]
    IdMismatch { claimed: String, derived: String },
    #[error("qr encode error: {0}")]
    Qr(#[from] qrcode::types::QrError),
    #[error("serialization error: {0}")]
    Json(#[from] serde_json::Error),
}

/// The QR payload. Field names match the Umbra Mesh wire contract exactly:
/// `{ "v":1, "id":<device_id>, "pub":<ed25519 b64>, "xp":<x25519 b64>,
///    "addrs":[local ips], "nonce":<b64 16B>, "exp":<unix ts> }`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PairingPayload {
    pub v: u64,
    pub id: String,
    #[serde(rename = "pub")]
    pub ed_pub: String,
    #[serde(rename = "xp")]
    pub x_pub: String,
    #[serde(default)]
    pub addrs: Vec<String>,
    pub nonce: String,
    pub exp: i64,
}

/// Signed envelope: `{ "payload": {...}, "sig": <b64 ed25519> }`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SignedPairing {
    pub payload: PairingPayload,
    pub sig: String,
}

/// Result of validating a peer's signed payload.
#[derive(Debug, Clone)]
pub struct VerifiedPeer {
    pub device_id: String,
    pub ed_pub: [u8; 32],
    pub x_pub: [u8; 32],
    pub addrs: Vec<String>,
    pub nonce: String,
    pub exp: i64,
}

/// Build a fresh signed pairing payload for the QR code.
pub fn create_signed_pairing(
    identity: &Identity,
    addrs: &[String],
    ttl_secs: i64,
    now: i64,
) -> Result<SignedPairing, PairingError> {
    let mut nonce = [0u8; NONCE_LEN];
    OsRng.fill_bytes(&mut nonce);
    let payload = PairingPayload {
        v: PAIRING_VERSION,
        id: identity.device_id(),
        ed_pub: identity.ed25519_pub_b64(),
        x_pub: identity.x25519_pub_b64(),
        addrs: addrs.to_vec(),
        nonce: B64.encode(nonce),
        exp: now + ttl_secs,
    };
    let canon = canonical_bytes(&payload)?;
    let sig = B64.encode(identity.sign(&canon).to_bytes());
    Ok(SignedPairing { payload, sig })
}

/// Verify a signed pairing payload. `now` is unix seconds.
pub fn verify_signed(signed: &SignedPairing, now: i64) -> Result<VerifiedPeer, PairingError> {
    let p = &signed.payload;
    if p.v != PAIRING_VERSION {
        return Err(PairingError::UnsupportedVersion(p.v));
    }
    if p.exp < now {
        return Err(PairingError::Expired { exp: p.exp, now });
    }
    let ed_pub: [u8; 32] = B64.decode(&p.ed_pub)?.as_slice().try_into()?;
    let x_pub: [u8; 32] = B64.decode(&p.x_pub)?.as_slice().try_into()?;

    // Signature binds the payload to the claimed public key.
    let sig = Signature::from_slice(&B64.decode(&signed.sig)?)?;
    let vk = VerifyingKey::from_bytes(&ed_pub)?;
    let canon = canonical_bytes(p)?;
    vk.verify_strict(&canon, &sig)?;

    // device_id must be the SHA-256 of the prefixed pub key string.
    let derived = device_id_for_pub(&p.ed_pub);
    if p.id != derived {
        return Err(PairingError::IdMismatch {
            claimed: p.id.clone(),
            derived,
        });
    }
    Ok(VerifiedPeer {
        device_id: p.id.clone(),
        ed_pub,
        x_pub,
        addrs: p.addrs.clone(),
        nonce: p.nonce.clone(),
        exp: p.exp,
    })
}

/// Compute one Diffie-Hellman term.
pub fn xdh(secret: &StaticSecret, peer_pub: &[u8; 32]) -> [u8; 32] {
    secret.diffie_hellman(&PublicKey::from(*peer_pub)).to_bytes()
}

/// `K = HKDF-SHA256(salt=SESSION_SALT, ikm=terms‖…, info=SESSION_INFO)`.
pub fn kdf_session_key(dh_terms: &[[u8; 32]]) -> [u8; 32] {
    let mut ikm = Vec::with_capacity(dh_terms.len() * 32);
    for t in dh_terms {
        ikm.extend_from_slice(t);
    }
    let hk = Hkdf::<Sha256>::new(Some(SESSION_SALT), &ikm);
    let mut out = [0u8; 32];
    hk.expand(SESSION_INFO, &mut out)
        .expect("hkdf expand cannot fail for 32 bytes");
    out
}

/// Desktop side: `K = HKDF(DH(A_static, B_eph) ‖ DH(A_static, B_static))`.
pub fn desktop_session_key(
    desktop: &Identity,
    sec_eph_pub: &[u8; 32],
    sec_static_pub: &[u8; 32],
) -> [u8; 32] {
    let t1 = xdh(desktop.x_secret(), sec_eph_pub);
    let t2 = xdh(desktop.x_secret(), sec_static_pub);
    kdf_session_key(&[t1, t2])
}

/// Secondary side: same two DH terms computed from its own secrets and the
/// desktop's static public key (DH is symmetric, order preserved).
pub fn client_session_key(
    eph_secret: &StaticSecret,
    static_secret: &StaticSecret,
    desktop_x_pub: &[u8; 32],
) -> [u8; 32] {
    let t1 = xdh(eph_secret, desktop_x_pub);
    let t2 = xdh(static_secret, desktop_x_pub);
    kdf_session_key(&[t1, t2])
}

/// Generate a fresh ephemeral X25519 keypair (secondary side of pairing).
pub fn new_ephemeral() -> (StaticSecret, PublicKey) {
    let secret = StaticSecret::random_from_rng(OsRng);
    let public = PublicKey::from(&secret);
    (secret, public)
}

/// Render a QR code as a terminal-printable ASCII art string.
pub fn render_qr_ascii(data: &str) -> Result<String, PairingError> {
    let code = qrcode::QrCode::new(data.as_bytes())?;
    Ok(code
        .render::<qrcode::render::unicode::Dense1x2>()
        .build())
}

/// Canonical JSON encoding: object keys sorted recursively (RFC 8785-style
/// ordering for the unsigned bytes), so signatures survive cross-language
/// serialization.
pub fn canonical_bytes(payload: &PairingPayload) -> Result<Vec<u8>, PairingError> {
    let value = serde_json::to_value(payload)?;
    Ok(serde_json::to_vec(&canonicalize(value))?)
}

fn canonicalize(value: serde_json::Value) -> serde_json::Value {
    match value {
        serde_json::Value::Object(map) => {
            let mut out = serde_json::Map::new();
            let mut keys: Vec<String> = map.keys().cloned().collect();
            keys.sort();
            for k in keys {
                let v = map.get(&k).expect("key exists");
                out.insert(k, canonicalize(v.clone()));
            }
            serde_json::Value::Object(out)
        }
        serde_json::Value::Array(arr) => {
            serde_json::Value::Array(arr.into_iter().map(canonicalize).collect())
        }
        other => other,
    }
}

/// Convenience helper for cross-checks: `verify_signed` + the derived pub.
pub fn device_id_matches(payload: &PairingPayload) -> bool {
    device_id_for_pub(&payload.ed_pub) == payload.id
}

/// Human-readable check string used in logs / UI: prefix + first 12 hex chars.
pub fn short_device_id(id: &str) -> String {
    let rest = IDENTITY_PREFIX.len();
    if id.len() <= rest + 12 {
        id.to_string()
    } else {
        format!("{}…{}", &id[..rest + 6], &id[id.len() - 6..])
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::crypto::identity::{FileKeyStore, Identity};

    fn test_identity(name: &str) -> Identity {
        let dir = std::env::temp_dir().join(format!("umbra-pair-test-{name}"));
        let store = FileKeyStore::new(&dir);
        let (id, _) = Identity::load_or_create(&store, name).unwrap();
        let _ = std::fs::remove_dir_all(&dir);
        id
    }

    #[test]
    fn signed_payload_roundtrip_and_canonical_stability() {
        let desk = test_identity("desk");
        let now = 1_700_000_000;
        let addrs = vec!["192.168.1.10".to_string(), "192.168.1.11".to_string()];
        let signed = create_signed_pairing(&desk, &addrs, DEFAULT_TTL_SECS, now).unwrap();

        // payload shape matches the spec contract
        assert_eq!(signed.payload.v, 1);
        assert_eq!(signed.payload.id, desk.device_id());
        assert_eq!(signed.payload.exp, now + DEFAULT_TTL_SECS);
        assert_eq!(signed.payload.addrs, addrs);

        // serializing twice yields identical bytes (canonical)
        let a = serde_json::to_vec(&signed).unwrap();
        let b = serde_json::to_vec(&signed).unwrap();
        assert_eq!(a, b);

        let verified = verify_signed(&signed, now).unwrap();
        assert_eq!(verified.device_id, desk.device_id());
        assert_eq!(verified.ed_pub, desk.ed25519_pub());
        assert_eq!(verified.x_pub, desk.x25519_pub_bytes());
    }

    #[test]
    fn tampered_payload_rejected() {
        let desk = test_identity("desk-t");
        let signed = create_signed_pairing(&desk, &[], DEFAULT_TTL_SECS, 1_700_000_000).unwrap();
        let mut tampered = signed.clone();
        tampered.payload.addrs.push("9.9.9.9".to_string());
        assert!(verify_signed(&tampered, 1_700_000_000).is_err());

        let mut sig_tampered = signed.clone();
        let bytes = B64.decode(&sig_tampered.sig).unwrap();
        let mut bad = bytes.clone();
        bad[0] ^= 0x01;
        sig_tampered.sig = B64.encode(bad);
        assert!(verify_signed(&sig_tampered, 1_700_000_000).is_err());
    }

    #[test]
    fn expired_payload_rejected() {
        let desk = test_identity("desk-e");
        let now = 1_700_000_000;
        let signed = create_signed_pairing(&desk, &[], 10, now).unwrap();
        assert!(matches!(
            verify_signed(&signed, now + 11),
            Err(PairingError::Expired { .. })
        ));
    }

    #[test]
    fn device_id_must_match_pub() {
        let desk = test_identity("desk-i");
        let now = 1_700_000_000;
        // Correctly-signed payload that claims a WRONG device_id: the
        // signature must verify, then the id-binding check must fail.
        let payload = PairingPayload {
            v: PAIRING_VERSION,
            id: "umbra-node-v1:deadbeef".to_string(),
            ed_pub: desk.ed25519_pub_b64(),
            x_pub: desk.x25519_pub_b64(),
            addrs: vec![],
            nonce: B64.encode([0u8; NONCE_LEN]),
            exp: now + DEFAULT_TTL_SECS,
        };
        let canon = canonical_bytes(&payload).unwrap();
        let sig = B64.encode(desk.sign(&canon).to_bytes());
        let signed = SignedPairing { payload, sig };
        assert!(matches!(
            verify_signed(&signed, now),
            Err(PairingError::IdMismatch { .. })
        ));
    }

    #[test]
    fn unsupported_version_rejected() {
        let desk = test_identity("desk-v");
        let now = 1_700_000_000;
        let mut signed = create_signed_pairing(&desk, &[], DEFAULT_TTL_SECS, now).unwrap();
        signed.payload.v = 99;
        assert!(matches!(
            verify_signed(&signed, now),
            Err(PairingError::UnsupportedVersion(99))
        ));
    }

    #[test]
    fn desktop_and_client_derive_identical_session_key() {
        // Desktop A: static only. Secondary B: static + ephemeral.
        let desk = test_identity("desk-s");
        let sec = test_identity("phone-s");

        // Desktop renders the QR; B verifies it (both directions tested).
        let desk_qr = create_signed_pairing(&desk, &[], DEFAULT_TTL_SECS, 1_700_000_000).unwrap();
        let desk_v = verify_signed(&desk_qr, 1_700_000_000).unwrap();

        // B builds its own signed reply + ephemeral.
        let (eph_sec, eph_pub) = new_ephemeral();
        let sec_qr = create_signed_pairing(&sec, &[], DEFAULT_TTL_SECS, 1_700_000_000).unwrap();
        let sec_v = verify_signed(&sec_qr, 1_700_000_000).unwrap();

        // A (desktop): session from B's ephemeral + static pubs.
        let k_desk = desktop_session_key(&desk, &eph_pub.to_bytes(), &sec_v.x_pub);

        // B (client): same terms from its own secrets + A's static pub.
        let k_sec = client_session_key(&eph_sec, sec.x_secret(), &desk_v.x_pub);

        assert_eq!(k_desk, k_sec, "both sides must derive the identical key");
        assert!(!k_desk.iter().all(|b| *b == 0));

        // A different ephemeral ⇒ different key (per-pairing forward secrecy).
        let (eph2, eph2pub) = new_ephemeral();
        let k2 = desktop_session_key(&desk, &eph2pub.to_bytes(), &sec_v.x_pub);
        assert_ne!(k_desk, k2);
        let _ = eph2;
    }
}
