#!/bin/bash
set -e

# ── PulseAudio runtime directory ─────────────────────────────────────────────
# PulseAudio as a non-root user needs a writable XDG_RUNTIME_DIR or it fails
# to create its socket (and every pactl call then fails silently).
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/tmp/pulse}"
export PULSE_SERVER="unix:${XDG_RUNTIME_DIR}/pulse/native"
mkdir -p "${XDG_RUNTIME_DIR}" && chmod 700 "${XDG_RUNTIME_DIR}"

# Never let clients autospawn a competing daemon with a different runtime dir;
# if the daemon below dies, we want a loud failure, not a phantom daemon.
PA_CLIENT_CONF="${HOME}/.config/pulse/client.conf"
mkdir -p "$(dirname "${PA_CLIENT_CONF}")"
{
    echo "autospawn = no"
    echo "daemon-binary = /usr/bin/pulseaudio"
} > "${PA_CLIENT_CONF}"

echo "[entrypoint] Starting Xvfb on :99 ..."
Xvfb :99 -screen 0 1280x720x24 -ac +extension GLX +render -noreset &
XVFB_PID=$!
sleep 1

echo "[entrypoint] Starting PulseAudio daemon ..."
pulseaudio --daemonize=no --exit-idle-time=-1 --log-target=stderr &
PA_PID=$!

# Wait for the daemon to accept commands; fail loudly if it never comes up.
for _ in $(seq 1 20); do
    if pactl info >/dev/null 2>&1; then
        break
    fi
    sleep 0.5
done
if ! pactl info >/dev/null 2>&1; then
    echo "[entrypoint] FATAL: PulseAudio daemon did not become ready" >&2
    exit 1
fi
echo "[entrypoint] PulseAudio daemon ready (pid=${PA_PID})"

echo "[entrypoint] Creating virtual audio devices ..."

# Audio graph (no loopback modules anywhere):
#
#   [remote participants] -> Chromium plays to default sink -> bot_speaker
#   bot hears meeting    <- parecord captures bot_speaker.monitor
#
#   [bot's TTS] -> pacat plays into sink bot_microphone
#   Chromium captures default source bot_microphone.monitor as its microphone
#   -> participants hear the bot via Chromium's WebRTC stream.
#
# Nothing connects bot_speaker or its monitor back into bot_microphone,
# so the bot can never hear itself.

# Sink that Chromium plays remote meeting audio into.
pactl load-module module-null-sink sink_name=bot_speaker \
    sink_properties=device.description="Bot_Speaker"

# Sink whose monitor Chromium captures as the bot's microphone.
pactl load-module module-null-sink sink_name=bot_microphone \
    sink_properties=device.description="Bot_Microphone"

# Route Chromium traffic to the right devices.
pactl set-default-sink bot_speaker
pactl set-default-source bot_microphone.monitor

# ── Verify the routing actually took effect ─────────────────────────────────
# set-default-* can return 0 while having no effect in odd daemon states, so
# assert on what the daemon reports rather than trusting the exit code.
DEFAULT_SINK="$(pactl info | sed -n 's/^Default Sink: //p')"
DEFAULT_SOURCE="$(pactl info | sed -n 's/^Default Source: //p')"
if [ "${DEFAULT_SINK}" != "bot_speaker" ]; then
    echo "[entrypoint] FATAL: default sink is '${DEFAULT_SINK}', expected 'bot_speaker'" >&2
    exit 1
fi
if [ "${DEFAULT_SOURCE}" != "bot_microphone.monitor" ]; then
    echo "[entrypoint] FATAL: default source is '${DEFAULT_SOURCE}', expected 'bot_microphone.monitor'" >&2
    exit 1
fi

echo "[entrypoint] Audio graph:"
pactl list short modules | grep null-sink || true
pactl info | sed -n 's/^Default \(Sink\|Source\): /  default \1: /p'

echo "[entrypoint] PulseAudio devices ready"

# Allow the container to run an arbitrary command (e.g. the smoke test)
# against the fully configured audio stack: pass CMD_OVERRIDE as an env var
# or append args to `docker run` / `docker compose run`.
if [ "$#" -gt 0 ]; then
    echo "[entrypoint] Executing override command: $*"
    exec "$@"
fi

echo "[entrypoint] Launching meeting bot ..."

# Hand off to the Python application (inherits XDG_RUNTIME_DIR / PULSE_SERVER)
exec python -m app.main
