#!/bin/bash
set -e

echo "[entrypoint] Starting Xvfb on :99 ..."
Xvfb :99 -screen 0 1280x720x24 -ac +extension GLX +render -noreset &
XVFB_PID=$!
sleep 1

echo "[entrypoint] Starting PulseAudio daemon ..."
pulseaudio --daemonize --exit-idle-time=-1 --log-target=stderr || true
sleep 1

echo "[entrypoint] Creating virtual audio devices ..."

# Create virtual sink (the bot "hears" from this)
pactl load-module module-null-sink sink_name=bot_speaker sink_properties=device.description="Bot_Speaker" || true

# Create virtual source (the bot "speaks" into this)
pactl load-module module-null-sink sink_name=bot_microphone sink_properties=device.description="Bot_Microphone" || true

# Create a monitor source on the speaker so parecord can capture it
# module-null-sink already creates bot_speaker.monitor automatically.

# Route bot_microphone monitor to the default source so meeting apps pick it up
pactl load-module module-loopback source=bot_microphone.monitor sink=@DEFAULT_SINK@ || true

echo "[entrypoint] PulseAudio devices ready"
echo "[entrypoint] Launching meeting bot ..."

# Hand off to the Python application
exec python -m app.main
