# Build + install the IDDCX indirect display driver for Umbra's virtual displays.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build-idd-display.ps1
#
# Requirements (see docs/virtual-display.md):
#   - Visual Studio 2022 Build Tools with the VC++ workload (or VS)
#   - Windows Driver Kit (WDK)
#   - Administrator shell (pnputil + bcdedit)
#   - A reboot into test-signing mode
#
# This automates the mechanical steps only. It does NOT sign the driver for
# production (WHQL) and cannot avoid the test-mode reboot.
$ErrorActionPreference = 'Stop'

Write-Host "== Umbra virtual-display driver build =="

# 1. Locate the WDK
$wdkRoot = Get-ChildItem "C:\Program Files (x86)\Windows Kits\10\build" -Directory -ErrorAction SilentlyContinue |
  Sort-Object Name -Descending | Select-Object -First 1
if (-not $wdkRoot) {
  Write-Error "WDK not found. Install it: winget install Microsoft.WindowsWDK.10.0.26100"
  exit 1
}
Write-Host "WDK: $($wdkRoot.FullName)"

# 2. Locate msbuild
$vswhere = "C:\Program Files (x86)\Microsoft Visual Studio\Installer\vswhere.exe"
if (-not (Test-Path $vswhere)) {
  Write-Error "Visual Studio / Build Tools not found (no vswhere). Install the VC++ workload first."
  exit 1
}
$msbuild = & $vswhere -latest -products * -requires Microsoft.Component.MSBuild -find MSBuild\**\Bin\MSBuild.exe | Select-Object -First 1
if (-not $msbuild) {
  Write-Error "msbuild not found. Install the Visual Studio Build Tools with the VC++ workload."
  exit 1
}
Write-Host "msbuild: $msbuild"

# 3. Clone the Microsoft sample (MIT)
$samples = Join-Path $env:USERPROFILE "Windows-driver-samples"
if (-not (Test-Path (Join-Path $samples "video\IndirectDisplay\IddSampleDriver.sln"))) {
  Write-Host "Cloning Windows-driver-samples ..."
  git clone --depth 1 https://github.com/microsoft/Windows-driver-samples.git $samples
}

# 4. Build the driver (x64 Release)
$sln = Join-Path $samples "video\IndirectDisplay\IddSampleDriver.sln"
Write-Host "Building $sln ..."
& $msbuild $sln /p:Configuration=Release /p:Platform=x64 /m
if ($LASTEXITCODE -ne 0) { Write-Error "msbuild failed ($LASTEXITCODE)"; exit 1 }

# 5. Enable test signing (one-time, needs reboot)
$testsigning = & bcdedit /enum {current} | Select-String "testsigning\s+Yes"
if (-not $testsigning) {
  Write-Host "Enabling test signing (a reboot is required before the driver loads) ..."
  & bcdedit /set testsigning on
  Write-Host "Reboot, then re-run this script to install the driver."
  exit 0
}

# 6. Install the driver
$inf = Join-Path $samples "video\IndirectDisplay\x64\Release\IddSampleDriver\IddSampleDriver.inf"
if (-not (Test-Path $inf)) {
  Write-Error "Built INF not found at $inf"
  exit 1
}
Write-Host "Installing driver ..."
pnputil /add-driver $inf /install
Write-Host "Done — the virtual monitor should now appear. Point VirtualDisplayNative at the driver to use it."
