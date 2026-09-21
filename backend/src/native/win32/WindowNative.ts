import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export interface WindowInfo {
  appName: string;
  windowTitle: string;
  url?: string;
  filePath?: string;
}

let cachedInfo: WindowInfo = { appName: 'desktop', windowTitle: '' };

const PS_SCRIPT = `$sig = @'
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder text, int count);
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
'@
$null = Add-Type -MemberDefinition $sig -Name "Win32API" -Namespace Win32 -PassThru
$hwnd = [Win32.Win32API]::GetForegroundWindow()
if ($hwnd -eq [IntPtr]::Zero) { exit }
$sb = New-Object System.Text.StringBuilder 512
[Win32.Win32API]::GetWindowText($hwnd, $sb, 512) | Out-Null
$procId = 0
[Win32.Win32API]::GetWindowThreadProcessId($hwnd, [ref]$procId) | Out-Null
$proc = Get-Process -Id $procId -ErrorAction SilentlyContinue
$name = if ($proc) { $proc.ProcessName } else { "" }
$title = $sb.ToString()

# Browser active-tab URL via the Chrome DevTools Protocol (best-effort;
# requires the browser to be launched with --remote-debugging-port).
$url = ""
$ports = @{ chrome = 9222; msedge = 9223; brave = 9224; opera = 9225 }
$candidates = @()
$base = $name.ToLower()
if ($ports.ContainsKey($base)) { $candidates += $ports[$base] }
$candidates += 9222
foreach ($port in ($candidates | Select-Object -Unique)) {
  try {
    $targets = Invoke-RestMethod -Uri "http://127.0.0.1:$port/json/list" -TimeoutSec 2 -ErrorAction Stop
    foreach ($t in $targets) {
      if ($t.type -ne 'page') { continue }
      if ($t.title -and $title -and $title.Contains($t.title)) { $url = $t.url; break }
      if ($url -eq "") { $url = $t.url }
    }
    if ($url -ne "") { break }
  } catch {}
}
Write-Output ($name + "|" + $title + "|" + $url)`;

export interface CursorPos {
  x: number;
  y: number;
}

const PS_CURSOR_SCRIPT = `$sig = @'
[DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
public struct POINT { public int X; public int Y; }
'@
$null = Add-Type -MemberDefinition $sig -Name "CursorAPI" -Namespace Win32 -PassThru
$p = New-Object Win32.CursorAPI+POINT
if ([Win32.CursorAPI]::GetCursorPos([ref]$p)) {
  Write-Output ($p.X + "|" + $p.Y)
} else {
  Write-Output "-1|-1"
}`;

/**
 * Current mouse cursor position in screen coordinates (used by screen
 * awareness so Umbra knows exactly what you're pointing at).
 */
export function getCursorPos(): CursorPos {
  try {
    const tmpDir = (() => {
      const d = path.join(process.env['USERPROFILE'] || 'C:\\Users\\default', '.umbra', 'tmp');
      if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
      return d;
    })();
    const psFile = path.join(tmpDir, 'get-cursor.ps1');
    fs.writeFileSync(psFile, PS_CURSOR_SCRIPT, 'utf-8');

    const output = execSync(
      `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${psFile}"`,
      { timeout: 3000, encoding: 'utf-8', windowsHide: true, maxBuffer: 4096 },
    ).trim();

    const parts = output.split('|');
    if (parts.length === 2) {
      const x = parseInt(parts[0], 10);
      const y = parseInt(parts[1], 10);
      if (!isNaN(x) && !isNaN(y)) return { x, y };
    }
  } catch {}
  return { x: 0, y: 0 };
}

const WIN_PATH_RE = /[A-Za-z]:\\[^"<>|?*\r\n]+|\\\\[^"<>|?*\r\n]+/;

/** Best-effort document path from a window title like "report.docx - Word". */
function extractFilePath(appName: string, windowTitle: string): string | undefined {
  const abs = windowTitle.match(WIN_PATH_RE);
  if (abs) return abs[0].trim();

  // "<name>.<ext> - <App>" / "<name> - <App>" — only meaningful for
  // document editors, not browsers/terminals.
  const editorHints = ['word', 'excel', 'powerpoint', 'notepad', 'notepad++', 'acrobat', 'reader', 'code', 'cursor', 'vim', 'sublime'];
  if (!editorHints.some(h => appName.includes(h))) return undefined;

  const sep = windowTitle.lastIndexOf(' - ');
  if (sep > 0) {
    const candidate = windowTitle.slice(0, sep).trim();
    if (candidate && /\.[A-Za-z0-9]{1,6}$/.test(candidate)) return candidate;
  }
  return undefined;
}

export function getForegroundWindowInfo(): WindowInfo {
  try {
    const tmpDir = (() => {
      const d = path.join(process.env['USERPROFILE'] || 'C:\\Users\\default', '.umbra', 'tmp');
      if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
      return d;
    })();
    const psFile = path.join(tmpDir, 'get-foreground.ps1');
    fs.writeFileSync(psFile, PS_SCRIPT, 'utf-8');

    const output = execSync(
      `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${psFile}"`,
      { timeout: 4000, encoding: 'utf-8', windowsHide: true, maxBuffer: 4096 },
    ).trim();

    if (output) {
      const parts = output.split('|');
      if (parts.length >= 2) {
        const rawName = parts[0] || 'unknown';
        const appName = rawName + '.exe';
        const windowTitle = parts.slice(1, parts.length - 1).join('|');
        const url = (parts[parts.length - 1] || '').trim() || undefined;
        const filePath = extractFilePath(rawName.toLowerCase(), windowTitle);
        cachedInfo = { appName, windowTitle, url, filePath };
      }
    }
  } catch {}
  return cachedInfo;
}
