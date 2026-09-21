FROM ubuntu:22.04 AS base

ENV DEBIAN_FRONTEND=noninteractive \
    PULSE_SERVER=unix:/run/pulse/native \
    DISPLAY=:99

# ── System packages ──────────────────────────────────────────────────────────
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates curl wget gnupg \
        ffmpeg \
        xvfb \
        pulseaudio \
        pulseaudio-utils \
        python3.11 \
        python3.11-dev \
        python3.11-venv \
        python3-pip \
        libffi-dev \
        libssl-dev \
        libsndfile1 \
        portaudio19-dev \
    && rm -rf /var/lib/apt/lists/*

# Make python3.11 the default python
RUN update-alternatives --install /usr/bin/python python /usr/bin/python3.11 1 \
    && update-alternatives --install /usr/bin/python3 python3 /usr/bin/python3.11 1

# ── Playwright + Chromium ────────────────────────────────────────────────────
RUN pip3 install --no-cache-dir playwright \
    && playwright install chromium \
    && playwright install-deps chromium

# ── Non-root user ────────────────────────────────────────────────────────────
RUN groupadd -r appuser && useradd -r -g appuser -m -s /bin/bash appuser
RUN mkdir -p /app /app/output /app/session_data \
    && chown -R appuser:appuser /app

# ── Application code ─────────────────────────────────────────────────────────
COPY requirements.txt /app/requirements.txt
RUN pip3 install --no-cache-dir -r /app/requirements.txt

COPY app/ /app/app/
COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

# ── Entrypoint ───────────────────────────────────────────────────────────────
USER appuser
WORKDIR /app
EXPOSE 8000

ENTRYPOINT ["/app/entrypoint.sh"]
