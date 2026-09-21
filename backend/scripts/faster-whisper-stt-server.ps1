# Start the Faster-Whisper STT server for Umbra OS.
# Usage: .\scripts\faster-whisper-stt-server.ps1
param(
  [int]$Port = 17510,
  [string]$Model = "base",
  [int]$DeviceIndex = -1
)

$ErrorActionPreference = "Stop"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$python = $env:PYTHON
if (-not $python) { $python = "python" }

# Check for faster-whisper
& $python -c "import faster_whisper" 2>$null
if ($LASTEXITCODE -ne 0) {
  Write-Host "[STT] Installing faster-whisper..."
  & $python -m pip install --quiet faster-whisper 2>&1 | Select-Object -Last 1
}

& $python "$scriptDir\faster-whisper-stt-server.py" --port $Port --model $Model --device-index $DeviceIndex
