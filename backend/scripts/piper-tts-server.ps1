# Start the Piper TTS server for Umbra OS.
# Usage: .\scripts\piper-tts-server.ps1
param(
  [int]$Port = 17520,
  [string]$Model = "it_IT-riccardo-medium"
)

$ErrorActionPreference = "Stop"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$python = $env:PYTHON
if (-not $python) { $python = "python" }

# Check for piper-tts
& $python -c "import piper" 2>$null
if ($LASTEXITCODE -ne 0) {
  Write-Host "[TTS] Installing piper-tts..."
  & $python -m pip install --quiet piper-tts 2>&1 | Select-Object -Last 1
}

& $python "$scriptDir\piper-tts-server.py" --port $Port --voice $Model
