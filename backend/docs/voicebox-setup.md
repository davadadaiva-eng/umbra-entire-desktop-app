# Voicebox (cloned-voice TTS) — local setup guide

Voicebox (jamiepine/voicebox) is the voice-cloning studio Umbra speaks through.
It runs as a local app whose backend exposes a REST API on
`http://127.0.0.1:17493`; Umbra's `VoiceboxClient` (src/core/voice/VoiceboxClient.ts)
talks to it for `/health`, `/profiles`, `/speak`, `/generate/stream`, and
`/transcribe`. Set `meeting.tts = "voicebox"` (or `POST /api/voice/speak
{provider:"voicebox"}`) and Umbra speaks in a cloned voice, in 23 languages,
across 7 engines (Qwen3-TTS, Chatterbox, Kokoro, LuxTTS, TADA, …).

This guide documents the exact steps used to bring it up on a fresh Windows
machine. The repo is cloned (sparse: `backend/` only) at `external/voicebox`
and **git-ignored**, so none of this is committed — only this doc is.

## 1. Install the toolchains

Voicebox's desktop app needs [Bun](https://bun.sh) and [Rust](https://rustup.rs);
the backend needs **Python 3.10+**.

```bash
# Bun (per-user, no admin)
npm install -g bun            # → bun 1.3.x
bun --version

# Rust (per-user, no admin; no PATH modification)
curl -sSfL https://win.rustup.rs/x86_64 -o /tmp/rustup-init.exe
/tmp/rustup-init.exe -y --default-toolchain stable --profile minimal --no-modify-path
# binary lands in %USERPROFILE%\.cargo\bin
export PATH="$PATH:/c/Users/<you>/.cargo/bin"
cargo --version && rustc --version

# Python 3.10+ (here: 3.12, 64-bit) — needed for the backend venv
"C:/Users/<you>/AppData/Local/Programs/Python/Python312/python.exe" --version
```

> Rust is required only for the Tauri desktop shell. If you only want the API
> (what Umbra needs), Bun + Python are enough — the backend is pure Python.

## 2. Backend Python environment

The `backend/` directory is a FastAPI app. The official `just setup` installs
`requirements.txt`; on this machine two adjustments were needed:

```bash
cd external/voicebox/backend

# Create the venv with a modern interpreter
"C:/Users/<you>/AppData/Local/Programs/Python/Python312/python.exe" -m venv venv
./venv/Scripts/python.exe -m pip install --upgrade pip

# Drop the Japanese phonemizer extra: `misaki[en,ja,zh]` pulls pyopenjtalk,
# which needs cmake + a C++ compiler (MSVC) that may not be installed. Only
# Japanese TTS is affected; en/zh and everything else works.
sed 's/misaki\[en,ja,zh\]/misaki[en,zh]/' requirements.txt > /tmp/vb-requirements.txt
./venv/Scripts/python.exe -m pip install -r /tmp/vb-requirements.txt

# The project's extra engines (match `just setup`):
./venv/Scripts/python.exe -m pip install --no-deps chatterbox-tts hume-tada
./venv/Scripts/python.exe -m pip install "git+https://github.com/QwenLM/Qwen3-TTS.git"
```

Verify:

```bash
cd external/voicebox/backend
./venv/Scripts/python.exe -c "import fastapi, uvicorn, torch, transformers, kokoro, qwen_tts, chatterbox_tts, tada, fastmcp; print('OK', torch.__version__)"
```

## 3. Start the backend

```bash
cd external/voicebox
./backend/venv/Scripts/python.exe -m backend.main --port 17493
# INFO: Uvicorn running on http://127.0.0.1:17493
```

Smoke-test:

```bash
curl -s http://127.0.0.1:17493/health
# {"status":"healthy","model_loaded":false,...,"backend_type":"pytorch","backend_variant":"cpu",...}
curl -s http://127.0.0.1:17493/profiles   # [] until you clone a voice
```

Notes from this machine's run:
- **CPU-only** (`backend_variant: cpu`) — no NVIDIA/Arc GPU detected. Fine for
  short utterances; a GPU makes cloning/generation much faster.
- First `/speak` per engine downloads that engine's model weights into
  `%USERPROFILE%\.cache\huggingface` (e.g. Kokoro ≈ 300 MB, Qwen3-TTS ≈ 2 GB).
- The database is created at `external/voicebox/data/voicebox.db`; profiles you
  clone persist there.

## 4. Clone a voice (two options)

**A. Desktop app (recommended for recording yourself):** run the Tauri app
(`bun install && just dev`, needs Rust + MSVC + WebView2) and use the Clone tab
— record a few seconds and it becomes a profile.

**B. API only (no desktop UI):**
- `POST /profiles/import` — upload a voice-profile ZIP (audio + metadata)
  exported from another Voicebox install.
- `POST /profiles` with a `VoiceProfileCreate` JSON body.

List profiles: `GET /profiles` → each has an `id` (the `voice` you pass to Umbra).

## 5. Point Umbra at it

Config (`~/.umbra/config.json`):

```jsonc
{
  "meeting": { "tts": "voicebox", "audioCable": "auto", "routeMic": true },
  "voice":  { "voiceboxUrl": "http://127.0.0.1:17493", "voiceboxProfile": "<profile-id>", "voiceboxEngine": "qwen" }
}
```

Then:

- `POST /api/voice/speak {"text":"hello","provider":"voicebox","voice":"<profile-id>"}`
  — speak anywhere, in a cloned voice.
- `GET /api/voice/tts/voices` — lists the running Voicebox profiles alongside
  VibeVoice voices.
- In a meeting: say "Hey Umbra, say hello to everyone" (with `meeting.tts =
  "voicebox"`), or route replies into the call with `meeting.audioCable =
  "auto"` so participants hear Umbra through the virtual cable.

## Troubleshooting

- **`pyopenjtalk` build fails** → see step 2 (drop the `ja` extra). It needs
  cmake + MSVC; without a compiler it cannot build on Windows.
- **Port 17493 in use** → something else owns it; run `--port 17494` and set
  `voice.voiceboxUrl` accordingly.
- **`/speak` slow the first time** → it is downloading the engine model; watch
  `%USERPROFILE%\.cache\huggingface`.
- **No MSVC** → the Tauri desktop app cannot be built (`cargo build` needs the
  C++ linker); the REST backend does not need Rust at all.
