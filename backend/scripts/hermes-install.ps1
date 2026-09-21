# hermes-install.ps1 — install the Hermes agent CLI for Umbra (Windows)
# Hermes is optional: Umbra's in-process agent (AgentRuntime.inProcessAgent)
# already handles browser + desktop control via browserAction/desktopAction.
# This script installs the external `hermes` binary when you want the dedicated
# reasoning engine for cloud or heavy agentic work. The binary is auto-detected
# at %LOCALAPPDATA%\hermes — no PATH edit needed.

$ErrorActionPreference = 'Stop'

$hermesHome = Join-Path $env:LOCALAPPDATA 'hermes'
$binDir = Join-Path $hermesHome 'bin'
$venvDir = Join-Path $hermesHome 'venv'

Write-Host "→ Hermes home: $hermesHome"

# If we ever publish a real hermes-agent PyPI package, this will install it:
#   python -m venv $venvDir
#   & "$venvDir\Scripts\python.exe" -m pip install hermes-agent

# For now, ensure the home exists and drop a shim that reports "not installed"
# so Umbra falls back to the in-process agent (which already has browser+app tools).
if (-not (Test-Path $hermesHome)) {
  New-Item -ItemType Directory -Path $hermesHome -Force | Out-Null
}
if (-not (Test-Path $binDir)) {
  New-Item -ItemType Directory -Path $binDir -Force | Out-Null
}

$shim = @'
@echo off
echo Hermes CLI shim — no external binary configured.
echo Umbra is using the in-process agent (browserAction/desktopAction) instead.
echo To use the dedicated Hermes engine, install the real binary to %LOCALAPPDATA%\hermes\bin\hermes.exe
exit /b 1
'@

# Only write the shim when no real binary exists
$hermesExe = Join-Path $binDir 'hermes.exe'
$hermesCmd = Join-Path $binDir 'hermes.cmd'
if (-not (Test-Path $hermesExe) -and -not (Test-Path $hermesCmd)) {
  Set-Content -Path $hermesCmd -Value $shim -Encoding Ascii
  Write-Host "✓ Shim installed at $hermesCmd (in-process agent will handle delegation)"
  Write-Host "  Real binary detection: src/core/agent/HermesAgent.ts:detectBin() checks %LOCALAPPDATA%\hermes"
} else {
  Write-Host "✓ Hermes already present — leaving it"
}

Write-Host "✓ Done. Umbra's in-process agent now exposes:"
Write-Host "  - browserAction (navigate/click/type/extract/... on Desktop2)"
Write-Host "  - desktopAction (open_app/open_chrome/read_screen/... on RealDesktop)"
Write-Host "  No cloud deploy needed for local agentic tasks."
