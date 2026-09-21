import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

/**
 * NativeCore — Windows low-level primitives for the Dual-Engine.
 *
 * One cached PowerShell script compiles a C# assembly (Win32.CoreNative) once
 * and exposes fast operations used by the Active engine (display enumeration
 * + DPI, cursor/keyboard state, circuit breaker), the Stealth engine
 * (CreateDesktopW / CreateProcessW with lpDesktop, targeted PostMessage
 * window input) and clean teardown.
 *
 * IMPORTANT: desktops are reference-counted kernel objects that are destroyed
 * when the last handle closes, and handles are process-local. The PowerShell
 * side therefore runs as a LONG-LIVED DAEMON that keeps desktop handles in a
 * static registry, so a desktop lives until `destroyStealthDesktop` (or the
 * daemon exits — stdin EOF kills it, which also auto-cleans desktops on crash).
 */

const SCRIPT_VERSION = '7';

export interface MonitorInfo {
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  workX: number;
  workY: number;
  workWidth: number;
  workHeight: number;
  dpi: number;
  dpiScale: number;
  isPrimary: boolean;
}

let scriptPath: string | null = null;

function getScriptPath(): string {
  if (scriptPath) return scriptPath;
  const tmpDir = path.join(process.env['USERPROFILE'] || 'C:\\Users\\default', '.umbra', 'tmp');
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
  scriptPath = path.join(tmpDir, 'native-core.ps1');
  return scriptPath;
}

function ensureScript(): void {
  const file = getScriptPath();
  try {
    const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : '';
    if (existing.includes(`#umbra-nativecore-v${SCRIPT_VERSION}`)) return;
  } catch { }
  fs.writeFileSync(file, PS_SCRIPT, 'utf-8');
}

// ── Daemon transport ─────────────────────────────────────────────────────────

let daemon: ChildProcess | null = null;
let daemonReady: Promise<void> | null = null;
let nextId = 1;
let buffer = '';
const pending = new Map<number, { resolve: (v: string | null) => void; reject: (e: Error) => void }>();

function startDaemon(): Promise<void> {
  if (daemonReady) return daemonReady;
  ensureScript();
  daemonReady = new Promise<void>((resolve, reject) => {
    const child = spawn(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', getScriptPath(), '__daemon__'],
      { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
    );
    daemon = child;
    child.stdout.setEncoding('utf-8');
    child.stderr.setEncoding('utf-8');
    child.stderr.on('data', (d: string) => {
      if (process.env['UMBRA_DEBUG']) process.stderr.write(`[nativecore] ${d}`);
    });
    let sawReady = false;
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk;
      let idx: number;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        let msg: { ready?: boolean; id?: number; ok?: boolean; value?: string; error?: string } | null = null;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg === null) continue;
        if (msg.ready) { sawReady = true; resolve(); continue; }
        if (msg.id !== undefined) {
          const p = pending.get(msg.id);
          if (p) {
            pending.delete(msg.id);
            if (msg.ok) p.resolve(msg.value ?? null);
            else p.reject(new Error(msg.error || 'nativecore error'));
          }
        }
      }
    });
    child.on('error', (e) => { if (!sawReady) reject(e); });
    child.on('exit', () => {
      daemon = null;
      daemonReady = null;
      for (const p of pending.values()) p.reject(new Error('nativecore daemon exited'));
      pending.clear();
    });
  });
  return daemonReady;
}

function request(cmd: string, args: string[] = [], timeoutMs = 60000): Promise<string | null> {
  return (async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await startDaemon();
        const id = nextId++;
        const result = await new Promise<string | null>((resolve, reject) => {
          const timer = setTimeout(() => {
            pending.delete(id);
            reject(new Error(`nativecore timeout: ${cmd}`));
          }, timeoutMs);
          pending.set(id, {
            resolve: (v) => { clearTimeout(timer); resolve(v); },
            reject: (e) => { clearTimeout(timer); reject(e); },
          });
          const d = daemon;
          if (!d || !d.stdin) throw new Error('nativecore daemon unavailable');
          d.stdin.write(JSON.stringify({ id, cmd, args }) + '\n');
        });
        return result;
      } catch (e) {
        try { daemon?.kill(); } catch { }
        daemon = null;
        daemonReady = null;
        if (attempt === 2) throw e;
        await new Promise(r => setTimeout(r, 500));
      }
    }
    return null;
  })();
}

/** Stop the daemon. Desktops it holds are destroyed by the OS on exit. */
export async function stop(): Promise<void> {
  const d = daemon;
  if (!d || d.exitCode !== null) { daemon = null; daemonReady = null; return; }
  if (d.stdin) { try { d.stdin.write('exit\n'); } catch { } }
  await new Promise<void>((resolve) => {
    const t = setTimeout(() => { try { d.kill(); } catch { } resolve(); }, 3000);
    d.once('exit', () => { clearTimeout(t); resolve(); });
  });
  daemon = null;
  daemonReady = null;
}

// ── Display ──────────────────────────────────────────────────────────────────

export async function enumerateMonitors(): Promise<MonitorInfo[]> {
  try {
    const out = await request('monitors');
    if (!out) return [];
    const parsed = JSON.parse(out) as MonitorInfo[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function getPrimaryMonitor(): Promise<MonitorInfo | null> {
  const monitors = await enumerateMonitors();
  return monitors.find(m => m.isPrimary) || monitors[0] || null;
}

export async function getCursorPos(): Promise<{ x: number; y: number } | null> {
  try {
    const out = await request('cursor');
    if (!out) return null;
    const m = out.match(/(-?\d+)\s*,\s*(-?\d+)/);
    if (!m) return null;
    return { x: parseInt(m[1], 10), y: parseInt(m[2], 10) };
  } catch {
    return null;
  }
}

export async function isKeyDown(vk: number): Promise<boolean> {
  try {
    const out = await request('key', [String(vk)]);
    return out === '1';
  } catch {
    return false;
  }
}

export async function isEscapePressed(): Promise<boolean> {
  return isKeyDown(27);
}

/** Release modifier keys (Ctrl/Shift/Alt/Win) — used by the circuit breaker. */
export async function releaseModifierKeys(): Promise<boolean> {
  try {
    const out = await request('release_keys');
    return out === 'OK';
  } catch {
    return false;
  }
}

// ── Stealth desktops ─────────────────────────────────────────────────────────

export async function createStealthDesktop(name: string): Promise<boolean> {
  try {
    const out = await request('desktop_create', [name]);
    return out === 'OK';
  } catch {
    return false;
  }
}

export async function destroyStealthDesktop(name: string): Promise<boolean> {
  try {
    const out = await request('desktop_destroy', [name]);
    return out === 'OK';
  } catch {
    return false;
  }
}

export async function desktopExists(name: string): Promise<boolean> {
  try {
    const out = await request('desktop_exists', [name]);
    return out === '1';
  } catch {
    return false;
  }
}

/** Launch a process inside a (hidden) desktop. Returns PID or null. */
export async function launchInDesktop(
  desktop: string,
  exe: string,
  args: string[] = [],
): Promise<number | null> {
  const cmdLine = [exe, ...args.map(a => (a.includes(' ') ? `"${a.replace(/"/g, '\\"')}"` : a))].join(' ');
  try {
    const out = await request('launch', [desktop, exe, cmdLine]);
    if (!out) return null;
    const m = out.match(/\d+/);
    return m ? parseInt(m[0], 10) : null;
  } catch {
    return null;
  }
}

// ── Targeted window input (PostMessage) ──────────────────────────────────────

export async function findWindow(titleOrProcess: string): Promise<number | null> {
  try {
    const out = await request('find', [titleOrProcess]);
    if (!out) return null;
    const m = out.match(/\d+/);
    if (!m) return null;
    const hwnd = parseInt(m[0], 10);
    return hwnd === 0 ? null : hwnd;
  } catch {
    return null;
  }
}

export async function postKey(hwnd: number, vk: number, keyUp: boolean): Promise<boolean> {
  try {
    const out = await request('post_key', [String(hwnd), String(vk), keyUp ? '1' : '0']);
    return out === 'OK';
  } catch {
    return false;
  }
}

export async function postClick(hwnd: number, x: number, y: number, button: 'left' | 'right' | 'middle'): Promise<boolean> {
  try {
    const out = await request('post_click', [String(hwnd), String(x), String(y), button]);
    return out === 'OK';
  } catch {
    return false;
  }
}

export async function postText(hwnd: number, text: string): Promise<boolean> {
  try {
    const out = await request('post_char', [String(hwnd), text]);
    return out === 'OK';
  } catch {
    return false;
  }
}

export async function postChar(hwnd: number, ch: string): Promise<boolean> {
  try {
    const out = await request('post_char', [String(hwnd), ch]);
    return out === 'OK';
  } catch {
    return false;
  }
}

export async function isWindowAlive(hwnd: number): Promise<boolean> {
  try {
    const out = await request('alive', [String(hwnd)]);
    return out === '1';
  } catch {
    return false;
  }
}

// ── Process helpers (teardown) ───────────────────────────────────────────────

export async function getProcessIdByName(name: string): Promise<number | null> {
  try {
    const out = await request('pid', [name]);
    if (!out) return null;
    const m = out.match(/\d+/);
    return m ? parseInt(m[0], 10) : null;
  } catch {
    return null;
  }
}

// ── PowerShell script (compiles C#, then daemon loop) ────────────────────────

const PS_SCRIPT = `#umbra-nativecore-v${SCRIPT_VERSION}
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = 'Stop'
$dll = Join-Path $env:USERPROFILE ('.umbra\\tmp\\CoreNative-v${SCRIPT_VERSION}.dll')
if (-not (Test-Path $dll)) {
  $src = @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

namespace Win32 {
  public class CoreNative {
    [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L; public int T; public int R; public int B; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct MONITORINFO { public int cbSize; public RECT rcMonitor; public RECT rcWork; public uint dwFlags; }
    public delegate bool MonitorEnumProc(IntPtr hMonitor, IntPtr hdcMonitor, ref RECT lprcMonitor, IntPtr dwData);

    [DllImport("user32.dll")] public static extern bool EnumDisplayMonitors(IntPtr hdc, IntPtr lprcClip, MonitorEnumProc lpfnEnum, IntPtr dwData);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern bool GetMonitorInfo(IntPtr hMonitor, ref MONITORINFO lpmi);
    [DllImport("shcore.dll")] public static extern int GetDpiForMonitor(IntPtr hmonitor, int dpiType, out uint dpiX, out uint dpiY);
    [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT lpPoint);
    [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int vKey);

    [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern IntPtr CreateDesktop(string lpszDesktop, IntPtr lpszDevice, IntPtr pDevmode, int dwFlags, uint dwDesiredAccess, IntPtr lpsa);
    [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern IntPtr OpenDesktop(string lpszDesktop, uint dwFlags, bool fInherit, uint dwDesiredAccess);
    [DllImport("user32.dll", SetLastError = true)] public static extern bool CloseDesktop(IntPtr hDesktop);
    [DllImport("user32.dll", SetLastError = true)] public static extern bool DestroyDesktop(IntPtr hDesktop);
    [DllImport("user32.dll", SetLastError = true)] public static extern bool EnumDesktopWindows(IntPtr hDesktop, EnumWindowsProc lpfn, IntPtr lParam);
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern bool CreateProcess(string lpApplicationName, string lpCommandLine, IntPtr lpProcessAttributes, IntPtr lpThreadAttributes, bool bInheritHandles, uint dwCreationFlags, IntPtr lpEnvironment, string lpCurrentDirectory, ref STARTUPINFO lpStartupInfo, out PROCESS_INFORMATION lpProcessInformation);
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct STARTUPINFO {
      public int cb; public string lpReserved; public string lpDesktop; public string lpTitle;
      public int dwX; public int dwY; public int dwXSize; public int dwYSize;
      public int dwXCountChars; public int dwYCountChars; public int dwFillAttribute; public int dwFlags;
      public short wShowWindow; public short cbReserved2; public IntPtr lpReserved2;
      public IntPtr hStdInput; public IntPtr hStdOutput; public IntPtr hStdError;
    }
    [StructLayout(LayoutKind.Sequential)]
    public struct PROCESS_INFORMATION { public IntPtr hProcess; public IntPtr hThread; public int dwProcessId; public int dwThreadId; }
    [DllImport("kernel32.dll", SetLastError = true)] public static extern bool CloseHandle(IntPtr hObject);

    [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)] public static extern IntPtr FindWindow(string lpClassName, string lpWindowName);
    [DllImport("user32.dll", SetLastError = true)] public static extern bool PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll", SetLastError = true)] public static extern IntPtr SendMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();

    public const uint WM_KEYDOWN = 0x0100;
    public const uint WM_KEYUP = 0x0101;
    public const uint WM_CHAR = 0x0102;
    public const uint WM_CLOSE = 0x0010;
    public const uint WM_LBUTTONDOWN = 0x0201;
    public const uint WM_LBUTTONUP = 0x0202;
    public const uint WM_RBUTTONDOWN = 0x0204;
    public const uint WM_RBUTTONUP = 0x0205;
    public const uint WM_MBUTTONDOWN = 0x0207;
    public const uint WM_MBUTTONUP = 0x0208;

    public const uint GENERIC_ALL = 0x10000000;
    public const uint DESKTOP_CREATEWINDOW = 0x0002;
    public const uint DESKTOP_WRITEOBJECTS = 0x0080;
    public const uint DESKTOP_SWITCHDESKTOP = 0x0100;
    public const uint DESKTOP_ENUMERATE = 0x0040;

    private static Dictionary<string, IntPtr> _desktops = new Dictionary<string, IntPtr>();

    public static string ListMonitors() {
      var list = new List<IntPtr>();
      MonitorEnumProc proc = delegate(IntPtr hMon, IntPtr hdc, ref RECT rc, IntPtr data) { list.Add(hMon); return true; };
      EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, proc, IntPtr.Zero);
      var sb = new StringBuilder();
      sb.Append("[");
      for (int i = 0; i < list.Count; i++) {
        var mi = new MONITORINFO(); mi.cbSize = Marshal.SizeOf(typeof(MONITORINFO));
        GetMonitorInfo(list[i], ref mi);
        uint dpiX = 96, dpiY = 96;
        try { GetDpiForMonitor(list[i], 0, out dpiX, out dpiY); } catch { }
        bool primary = (mi.dwFlags & 1) != 0;
        if (i > 0) sb.Append(",");
        sb.Append("{");
        sb.Append("\\"name\\":\\"DISPLAY" + (i + 1) + "\\",");
        sb.Append("\\"x\\":" + mi.rcMonitor.L + ",");
        sb.Append("\\"y\\":" + mi.rcMonitor.T + ",");
        sb.Append("\\"width\\":" + (mi.rcMonitor.R - mi.rcMonitor.L) + ",");
        sb.Append("\\"height\\":" + (mi.rcMonitor.B - mi.rcMonitor.T) + ",");
        sb.Append("\\"workX\\":" + mi.rcWork.L + ",");
        sb.Append("\\"workY\\":" + mi.rcWork.T + ",");
        sb.Append("\\"workWidth\\":" + (mi.rcWork.R - mi.rcWork.L) + ",");
        sb.Append("\\"workHeight\\":" + (mi.rcWork.B - mi.rcWork.T) + ",");
        sb.Append("\\"dpi\\":" + dpiX + ",");
        sb.Append("\\"dpiScale\\":" + Math.Round(dpiX / 96.0, 3) + ",");
        sb.Append("\\"isPrimary\\":" + (primary ? "true" : "false"));
        sb.Append("}");
      }
      sb.Append("]");
      return sb.ToString();
    }

    public static string GetCursor() {
      POINT p; GetCursorPos(out p);
      return p.X + "," + p.Y;
    }

    public static string KeyState(int vk) {
      return (GetAsyncKeyState(vk) & 0x8000) != 0 ? "1" : "0";
    }

    public static int FindWindowBy(string name) {
      IntPtr h = FindWindow(null, name);
      if (h != IntPtr.Zero) return h.ToInt32();
      h = FindWindow(name, null);
      if (h != IntPtr.Zero) return h.ToInt32();
      return 0;
    }

    public static string CreateDesktopNamed(string name) {
      if (_desktops.ContainsKey(name)) return "OK";
      IntPtr h = CreateDesktop(name, IntPtr.Zero, IntPtr.Zero, 0, GENERIC_ALL, IntPtr.Zero);
      if (h == IntPtr.Zero) return "ERR:" + Marshal.GetLastWin32Error();
      _desktops[name] = h;
      return "OK";
    }

    public static string DestroyDesktopNamed(string name) {
      IntPtr h;
      if (_desktops.TryGetValue(name, out h)) {
        _desktops.Remove(name);
      } else {
        h = OpenDesktop(name, 0, false, DESKTOP_CREATEWINDOW | DESKTOP_WRITEOBJECTS | DESKTOP_SWITCHDESKTOP);
      }
      if (h == IntPtr.Zero) return "ERR:" + Marshal.GetLastWin32Error();
      var closed = new List<IntPtr>();
      EnumDesktopWindows(h, delegate(IntPtr wnd, IntPtr lp) { closed.Add(wnd); return true; }, IntPtr.Zero);
      foreach (var wnd in closed) PostMessage(wnd, WM_CLOSE, IntPtr.Zero, IntPtr.Zero);
      System.Threading.Thread.Sleep(150);
      if (DestroyDesktop(h)) return "OK";
      foreach (var wnd in closed) SendMessage(wnd, WM_CLOSE, IntPtr.Zero, IntPtr.Zero);
      System.Threading.Thread.Sleep(200);
      if (DestroyDesktop(h)) return "OK";
      CloseDesktop(h);
      return "ERR:" + Marshal.GetLastWin32Error();
    }

    public static string DesktopExistsNamed(string name) {
      if (_desktops.ContainsKey(name)) return "1";
      IntPtr h = OpenDesktop(name, 0, false, DESKTOP_ENUMERATE);
      if (h == IntPtr.Zero) return "0";
      CloseDesktop(h);
      return "1";
    }

    public static string LaunchInDesktop(string desktop, string exe, string cmdLine) {
      var si = new STARTUPINFO();
      si.cb = Marshal.SizeOf(typeof(STARTUPINFO));
      si.lpDesktop = desktop;
      si.dwFlags = 1;
      si.wShowWindow = 0;
      PROCESS_INFORMATION pi;
      bool ok = CreateProcess(exe, cmdLine, IntPtr.Zero, IntPtr.Zero, false, 0, IntPtr.Zero, null, ref si, out pi);
      if (!ok) return "ERR:" + Marshal.GetLastWin32Error();
      CloseHandle(pi.hProcess);
      CloseHandle(pi.hThread);
      return pi.dwProcessId.ToString();
    }

    public static string PostKeyMsg(int hwnd, int vk, bool up) {
      PostMessage((IntPtr)hwnd, up ? WM_KEYUP : WM_KEYDOWN, (IntPtr)vk, IntPtr.Zero);
      return "OK";
    }

    public static string PostClickMsg(int hwnd, int x, int y, string button) {
      IntPtr lp = (IntPtr)((y << 16) | (x & 0xFFFF));
      uint down = WM_LBUTTONDOWN, up = WM_LBUTTONUP;
      if (button == "right") { down = WM_RBUTTONDOWN; up = WM_RBUTTONUP; }
      else if (button == "middle") { down = WM_MBUTTONDOWN; up = WM_MBUTTONUP; }
      PostMessage((IntPtr)hwnd, down, IntPtr.Zero, lp);
      PostMessage((IntPtr)hwnd, up, IntPtr.Zero, lp);
      return "OK";
    }

    public static string PostCharMsg(int hwnd, string ch) {
      if (ch.Length == 0) return "OK";
      foreach (char c in ch) {
        PostMessage((IntPtr)hwnd, WM_CHAR, (IntPtr)c, IntPtr.Zero);
      }
      return "OK";
    }

    public static string ReleaseModifiers() {
      IntPtr h = GetForegroundWindow();
      PostMessage(h, WM_KEYUP, (IntPtr)17, IntPtr.Zero);
      PostMessage(h, WM_KEYUP, (IntPtr)16, IntPtr.Zero);
      PostMessage(h, WM_KEYUP, (IntPtr)18, IntPtr.Zero);
      PostMessage(h, WM_KEYUP, (IntPtr)91, IntPtr.Zero);
      return "OK";
    }
  }
}
'@
  try {
    Add-Type -TypeDefinition $src -OutputAssembly $dll -ErrorAction Stop
  } catch {
    Add-Type -TypeDefinition $src
  }
}
try { Add-Type -Path $dll } catch { }

function Invoke-UmbraCore($cmd, $A) {
  switch ($cmd) {
    'monitors' { return [Win32.CoreNative]::ListMonitors() }
    'cursor' { return [Win32.CoreNative]::GetCursor() }
    'key' { return [Win32.CoreNative]::KeyState([int]$A[0]) }
    'desktop_create' { return [Win32.CoreNative]::CreateDesktopNamed([string]$A[0]) }
    'desktop_destroy' { return [Win32.CoreNative]::DestroyDesktopNamed([string]$A[0]) }
    'desktop_exists' { return [Win32.CoreNative]::DesktopExistsNamed([string]$A[0]) }
    'launch' { return [Win32.CoreNative]::LaunchInDesktop([string]$A[0], [string]$A[1], [string]$A[2]) }
    'find' { return [Win32.CoreNative]::FindWindowBy([string]$A[0]).ToString() }
    'post_key' { return [Win32.CoreNative]::PostKeyMsg([int]$A[0], [int]$A[1], $A[2] -eq '1') }
    'post_click' { return [Win32.CoreNative]::PostClickMsg([int]$A[0], [int]$A[1], [int]$A[2], [string]$A[3]) }
    'post_char' { return [Win32.CoreNative]::PostCharMsg([int]$A[0], [string]$A[1]) }
    'release_keys' { return [Win32.CoreNative]::ReleaseModifiers() }
    'alive' { if ([Win32.CoreNative]::IsWindow([IntPtr][int]$A[0])) { return '1' } return '0' }
    'pid' {
      $p = Get-Process -Name ([string]$A[0]) -ErrorAction SilentlyContinue | Select-Object -First 1
      if ($p) { return $p.Id.ToString() }
      return '0'
    }
    default { throw "unknown command: $cmd" }
  }
}

if ($args[0] -eq '__daemon__') {
  [Console]::Out.WriteLine('{"ready":true}')
  [Console]::Out.Flush()
  while ($true) {
    $line = [Console]::In.ReadLine()
    if ($null -eq $line) { break }
    $line = $line.Trim()
    if ($line -eq '') { continue }
    if ($line -eq 'exit') { break }
    $req = $null
    try { $req = $line | ConvertFrom-Json } catch { $req = $null }
    if ($null -eq $req -or $null -eq $req.cmd) { continue }
    $id = $req.id
    $A = @($req.args)
    $ok = $true
    $val = ''
    $errMsg = ''
    try {
      $val = Invoke-UmbraCore ([string]$req.cmd) $A
    } catch {
      $ok = $false
      $errMsg = $_.Exception.Message
    }
    $resp = @{ id = $id; ok = $ok }
    if ($ok) { $resp.value = $val } else { $resp.error = $errMsg }
    [Console]::Out.WriteLine(($resp | ConvertTo-Json -Compress))
    [Console]::Out.Flush()
  }
  exit 0
}

Invoke-UmbraCore $args[0] @($args[1..($args.Count - 1)])
`;
