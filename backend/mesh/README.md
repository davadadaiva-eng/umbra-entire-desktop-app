# Umbra Mesh — P2P Multi-Device Engine

Rust core (networking + cryptography) with a TypeScript host binding, embedded
in Umbra OS. Zero third-party cloud: all payloads, video streams and keys are
peer-to-peer or end-to-end encrypted.

## Layout

```
mesh/
  Cargo.toml                 workspace
  crates/umbra-mesh/         core library
    src/crypto/              M1: identity + zero-knowledge pairing
    src/db.rs                SQLite pairing store (mesh_devices)
    src/network/             M2: discovery, NAT punch, Noise tunnel
    src/stream/              M3: capture, encode, relay
    src/swarm/               M4: scheduler, executor, transfer
  crates/umbra-meshd/        daemon binary (stdio JSON-RPC)
  ts/                        TypeScript host binding (MeshDaemonClient)
```

## Build & test

```bash
# in mesh/
cargo build --release            # native core + daemon
cargo test                       # Rust unit tests (crypto, pairing, db)
npm --prefix ts install          # TS binding deps (first time)
npm --prefix ts run build        # compile binding
npm --prefix ts run e2e          # end-to-end: spawn daemon, drive pairing
```

Requirements: Rust stable (MSVC target) + Visual Studio Build Tools (C++
workload) on Windows; Xcode CLT on macOS.

## Running the daemon

```bash
# interactive check
cargo run -p umbra-meshd -- --data-dir %TEMP%\umbra-mesh-demo --keystore file
# feed it JSON-RPC from a script:
echo '{"jsonrpc":"2.0","id":1,"method":"mesh.status","params":{}}' | umbra-meshd
```

In production the daemon is spawned by `MeshDaemonClient` (ts/src/index.ts):

| Option | Meaning |
| --- | --- |
| `--data-dir <path>` | runtime dir (default `%APPDATA%\umbra-mesh`; `UMBRA_MESH_DIR` env overrides) |
| `--keystore os\|file` | `os` = Windows Credential Manager / macOS Keychain (DPAPI-backed), `file` = fallback (test/headless) |
| `--name <name>` | human name for this node |

## JSON-RPC contract (v1, M1)

Transport: newline-delimited JSON over stdin/stdout; logs → stderr.
Responses carry `id`; `error.code` follows JSON-RPC 2.0 conventions.

| Method | Params | Returns |
| --- | --- | --- |
| `mesh.status` | — | identity, keystore, addrs, paired device count |
| `mesh.pair.create` | `ttl?` | `{ device_id, wire, exp, qr_ascii }` |
| `mesh.pair.verify` | `wire` (JSON string) | `{ ok, device_id, ed_pub, xp, addrs, exp }` |
| `mesh.pair.respond` | `wire`, `eph_pub` (b64), `device_name?`, `device_type?`, `permission_level?` | `{ ok, device_id, pairing, session_key }` |
| `mesh.pair.demo` | — | full handshake on one host; `match` proves key equality (TEST ONLY) |
| `mesh.devices.list` | — | `{ devices: DeviceRow[] }` |
| `mesh.devices.revoke` | `device_id` | `{ ok, device_id }` |

Events (notifications, reserved for M2+): `mesh.event` with `method`-style
params.

## Crypto model (M1)

- **Root secret**: 32-byte seed, stored in the OS keystore (DPAPI/Credential
  Manager on Windows). `--keystore file` exists for headless hosts.
- **Identity keys** derived from the seed:
  - Ed25519 signing key → signs pairing payloads; `device_id` = SHA-256 of
    `umbra-node-v1:<b64 pub>` (hex).
  - X25519 static key → `x = SHA256(seed ‖ "umbra-x25519-v1")`, used for the
    pairing ECDH (and Noise static key in M2). No unsafe ed↔x conversions.
- **Pairing payload** (QR content): `{ v:1, id, pub, xp, addrs, nonce, exp }`
  signed with Ed25519 over canonical (key-sorted) JSON, so signatures verify
  from any runtime.
- **Session key** (after secondary replies with its own signed payload +
  ephemeral pub):
  `K = HKDF-SHA256(salt="umbra-mesh-pair-v1", ikm = DH(A_static,B_eph) ‖ DH(A_static,B_static))`
  — secondary's ephemeral gives forward secrecy; M2's Noise IKpsk2 tunnel
  adds full PFS with 3600 s key rotation.

## Schema

`mesh_devices` (SQLite, WAL): `device_id` PK, `device_name`, `device_type`
CHECK(`mobile`|`tablet`|`wearable`|`desktop`), `public_key`, `x_public_key`,
`permission_level` CHECK(`admin`|`monitor`|`compute`|`standard`) DEFAULT
`standard`, `last_seen_at`, `created_at`.

Re-pairing refreshes name/type/`last_seen_at` but **never** overwrites an
existing `permission_level` (privileges only change via explicit policy).

## Roadmap

- M2 — mDNS discovery (`_umbra-mesh._udp.local`), Noise IKpsk2 tunnel with
  3600 s rotation, STUN/ICE hole punching + DERP relay fallback, <500 ms
  reconnection state machine.
- M3 — DXGI Desktop Duplication capture, NVENC/AMF encode (H.264/HEVC/AV1,
  zero B-frames, CBR, intra-refresh), RTP over Noise, input backchannel.
- M4 — swarm scheduler (compute capability vector), protobuf task manifests,
  sandboxed execution on Desktop 2, zstd + multi-stream LEDBAT artifact
  transfer.
