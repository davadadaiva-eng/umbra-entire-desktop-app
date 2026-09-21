#!/usr/bin/env bash
# Build the Umbra mesh daemon (mesh/crates/umbra-meshd) into a release binary.
#
#   npm run mesh:build
#
# Requirements: Rust (rustup) + a Windows C linker — Visual Studio 2022 Build
# Tools with the VC++ workload (link.exe), or MinGW-w64 gcc. On Windows the
# MSVC path is the documented one (see mesh/README.md).
#
# Once built, the daemon lands at mesh/target/release/umbra-meshd(.exe) and
# MeshBridge (src/p2p/MeshBridge.ts) will detect and start it automatically.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MESH_DIR="$SCRIPT_DIR/../mesh"

# Locate cargo (rustup installs it per-user, often not on PATH).
if command -v cargo >/dev/null 2>&1; then
  CARGO=cargo
elif [ -x "$USERPROFILE/.cargo/bin/cargo" ]; then
  CARGO="$USERPROFILE/.cargo/bin/cargo"
elif [ -x "$HOME/.cargo/bin/cargo" ]; then
  CARGO="$HOME/.cargo/bin/cargo"
else
  echo "[mesh] cargo not found — install Rust: https://rustup.rs" >&2
  exit 1
fi

echo "[mesh] using $CARGO"
cd "$MESH_DIR"
"$CARGO" build --release -p umbra-meshd

BIN="$MESH_DIR/target/release/umbra-meshd"
if [ -f "$BIN.exe" ]; then BIN="$BIN.exe"; fi
echo "[mesh] built: $BIN"
