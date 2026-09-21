import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export interface CaptureFrame {
  data: Buffer;
  width: number;
  height: number;
  stride: number;
  timestamp: number;
  format: 'bgra32' | 'nv12' | 'png';
}

export interface ScreenPng {
  buffer: Buffer;
  width: number;
  height: number;
  capturedAt: number;
}

const PS_CAPTURE_SCRIPT_V2 = `Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
$screen = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bitmap = New-Object System.Drawing.Bitmap $screen.Width, $screen.Height
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.CopyFromScreen($screen.X, $screen.Y, 0, 0, $screen.Size)
$ms = New-Object System.IO.MemoryStream
$bitmap.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
$bytes = $ms.ToArray()
$graphics.Dispose()
$bitmap.Dispose()
$ms.Dispose()
Write-Output ("SIZE|" + $screen.Width + "|" + $screen.Height)
[System.Convert]::ToBase64String($bytes)`;

/** Capture the whole primary display as a PNG; returns buffer + real pixel
 *  dimensions (DPI-agreed with SetCursorPos through the same non-DPI-aware
 *  PowerShell coordinate space). */
export async function captureScreenPng(): Promise<ScreenPng | null> {
  const output = runPS(PS_CAPTURE_SCRIPT_V2);
  if (!output) return null;
  const lines = output.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  const sizeLine = lines.find(l => l.startsWith('SIZE|'));
  const b64Line = lines.filter(l => l.length > 100).pop();
  if (!b64Line) return null;
  let width = 1920;
  let height = 1080;
  if (sizeLine) {
    const parts = sizeLine.split('|');
    width = parseInt(parts[1], 10) || width;
    height = parseInt(parts[2], 10) || height;
  }
  return { buffer: Buffer.from(b64Line, 'base64'), width, height, capturedAt: Date.now() };
}

// Captures a specific window (by process name or title) even when it lives on
// another Windows virtual desktop or is not the foreground window.
const PS_WINDOW_CAPTURE_SCRIPT = `$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$src = @'
using System;
using System.Runtime.InteropServices;
namespace Win32 {
  public class CapW {
    [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdcBlt, uint nFlags);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
    [DllImport("user32.dll")] public static extern IntPtr FindWindow(string cls, string title);
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L; public int T; public int R; public int B; }
  }
}
'@
Add-Type -TypeDefinition $src
function Get-TargetWindow($name) {
  $h = [Win32.CapW]::FindWindow($null, $name)
  if ($h -eq [IntPtr]::Zero) {
    $procs = Get-Process -Name $name -ErrorAction SilentlyContinue
    foreach ($p in $procs) {
      if ($p.MainWindowHandle -ne [IntPtr]::Zero) { $h = $p.MainWindowHandle; break }
    }
  }
  return $h
}
$h = Get-TargetWindow $args[0]
if ($h -eq [IntPtr]::Zero) { exit 2 }
$r = New-Object 'Win32.CapW+RECT'
[Win32.CapW]::GetWindowRect($h, [ref]$r) | Out-Null
$w = [Math]::Max(1, $r.R - $r.L)
$hh = [Math]::Max(1, $r.B - $r.T)
$bmp = New-Object System.Drawing.Bitmap $w, $hh
$g = [System.Drawing.Graphics]::FromImage($bmp)
$hdc = $g.GetHdc()
try {
  [Win32.CapW]::PrintWindow($h, $hdc, 2) | Out-Null
} finally {
  $g.ReleaseHdc($hdc)
}
$ms = New-Object System.IO.MemoryStream
$bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
$bytes = $ms.ToArray()
$g.Dispose()
$bmp.Dispose()
$ms.Dispose()
[System.Convert]::ToBase64String($bytes)`;

let lastCapture: { data: Buffer; width: number; height: number } | null = null;

function ensureCacheDir(): string {
  const dir = path.join(process.env['USERPROFILE'] || 'C:\\Users\\default', '.umbra', 'tmp');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function runPS(script: string, scriptArgs: string[] = []): string | null {
  try {
    const tmpDir = ensureCacheDir();
    const psFile = path.join(tmpDir, `capture-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.ps1`);
    fs.writeFileSync(psFile, script, 'utf-8');
    try {
      const quoted = scriptArgs.map(a => `"${a.replace(/"/g, '`"')}"`).join(' ');
      const output = execSync(
        `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${psFile}" ${quoted}`,
        { timeout: 15000, encoding: 'utf-8', windowsHide: true, maxBuffer: 15 * 1024 * 1024 },
      ).trim();
      return output;
    } finally {
      try { fs.unlinkSync(psFile); } catch { }
    }
  } catch {
    return null;
  }
}

export async function captureWindowPng(windowMatch: string): Promise<Buffer | null> {
  const output = runPS(PS_WINDOW_CAPTURE_SCRIPT, [windowMatch]);
  if (!output) return null;
  const lines = output.split('\n');
  const lastLine = lines.filter((l: string) => l.length > 100).pop();
  if (!lastLine) return null;
  return Buffer.from(lastLine.trim(), 'base64');
}

const PS_DISPLAYS_SCRIPT = `Add-Type -AssemblyName System.Windows.Forms
$i = 0
foreach ($s in [System.Windows.Forms.Screen]::AllScreens) {
  $name = if ($s.DeviceName) { $s.DeviceName } else { "DISPLAY" + ($i + 1) }
  Write-Output ($i.ToString() + "|" + $name + "|" + $s.Bounds.Width + "|" + $s.Bounds.Height + "|" + $s.Bounds.X + "|" + $s.Bounds.Y)
  $i++
}`;

const PS_REGION_CAPTURE_SCRIPT = `Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
$x = [int]$args[0]; $y = [int]$args[1]; $w = [int]$args[2]; $h = [int]$args[3]
if ($w -le 0 -or $h -le 0) { exit 3 }
$bitmap = New-Object System.Drawing.Bitmap $w, $h
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.CopyFromScreen($x, $y, 0, 0, (New-Object System.Drawing.Size $w, $h))
$ms = New-Object System.IO.MemoryStream
$bitmap.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
$bytes = $ms.ToArray()
$graphics.Dispose()
$bitmap.Dispose()
$ms.Dispose()
[System.Convert]::ToBase64String($bytes)`;

const PS_JPEG_CONVERT_SCRIPT = `Add-Type -AssemblyName System.Drawing
$b64 = $args[0]
$quality = if ($args.Count -ge 2) { [int]$args[1] } else { 80 }
$png = [System.Convert]::FromBase64String($b64)
$msIn = New-Object System.IO.MemoryStream(,$png)
$img = [System.Drawing.Image]::FromStream($msIn)
$msOut = New-Object System.IO.MemoryStream
$enc = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
$ep = New-Object System.Drawing.Imaging.EncoderParameters 1
$ep.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter ([System.Drawing.Imaging.Encoder]::Quality, [long]$quality)
$img.Save($msOut, $enc, $ep)
$bytes = $msOut.ToArray()
$img.Dispose(); $msIn.Dispose(); $msOut.Dispose()
[System.Convert]::ToBase64String($bytes)`;

export async function captureDisplay(displayId: number): Promise<CaptureFrame | null> {
  const displays = await getDisplayList();
  const target = displays.find(d => d.id === displayId) ?? displays[0];
  const png = await captureRegion(displayId, target?.x ?? 0, target?.y ?? 0, target?.width ?? 1920, target?.height ?? 1080);
  if (!png) {
    if (lastCapture) {
      return {
        data: lastCapture.data,
        width: lastCapture.width, height: lastCapture.height,
        stride: lastCapture.width * 4,
        timestamp: Date.now(), format: 'png',
      };
    }
    return null;
  }
  lastCapture = { data: png.data, width: png.width, height: png.height };
  return png;
}

export async function captureRegion(
  displayId: number,
  x: number, y: number, width: number, height: number,
): Promise<CaptureFrame | null> {
  void displayId;
  const output = runPS(PS_REGION_CAPTURE_SCRIPT, [String(x), String(y), String(width), String(height)]);
  if (!output) return null;
  const lastLine = output.split('\n').filter((l: string) => l.trim().length > 100).pop();
  if (!lastLine) return null;
  const data = Buffer.from(lastLine.trim(), 'base64');
  return {
    data,
    width: Math.max(1, Math.floor(width)),
    height: Math.max(1, Math.floor(height)),
    stride: Math.max(1, Math.floor(width)) * 4,
    timestamp: Date.now(),
    format: 'png',
  };
}

export interface DisplayInfo {
  id: number;
  name: string;
  width: number;
  height: number;
  x: number;
  y: number;
  isVirtual: boolean;
}

export async function getDisplayList(): Promise<DisplayInfo[]> {
  const output = runPS(PS_DISPLAYS_SCRIPT);
  if (!output) {
    return [{ id: 0, name: 'Primary Display', width: 1920, height: 1080, x: 0, y: 0, isVirtual: false }];
  }
  const displays: DisplayInfo[] = [];
  for (const line of output.split('\n')) {
    const parts = line.trim().split('|');
    if (parts.length < 6) continue;
    const id = parseInt(parts[0], 10);
    const width = parseInt(parts[2], 10);
    const height = parseInt(parts[3], 10);
    const x = parseInt(parts[4], 10);
    const y = parseInt(parts[5], 10);
    if (isNaN(id) || isNaN(width) || isNaN(height)) continue;
    displays.push({
      id,
      name: parts[1] || `Display ${id + 1}`,
      width,
      height,
      x: isNaN(x) ? 0 : x,
      y: isNaN(y) ? 0 : y,
      isVirtual: /IDD|Indirect|Virtual|UMBRA/i.test(parts[1] || ''),
    });
  }
  return displays.length ? displays : [{ id: 0, name: 'Primary Display', width: 1920, height: 1080, x: 0, y: 0, isVirtual: false }];
}

export function frameToJPEG(frame: CaptureFrame, quality: number = 80): Buffer {
  if (frame.format === 'png') {
    const output = runPS(PS_JPEG_CONVERT_SCRIPT, [frame.data.toString('base64'), String(quality)]);
    if (output) {
      const lastLine = output.split('\n').filter((l: string) => l.trim().length > 100).pop();
      if (lastLine) return Buffer.from(lastLine.trim(), 'base64');
    }
    return frame.data;
  }
  return frame.data;
}

export function frameToBase64(frame: CaptureFrame): string {
  return frame.data.toString('base64');
}
