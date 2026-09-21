import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Input Native — Windows input via PowerShell user32 P/Invoke.
 * Replaces the old stub. Uses SendInput/keybd_event/mouse_event through a
 * cached PowerShell script + compiled InputW.dll (compiled once, loaded fast).
 */

let scriptPath: string | null = null;
let clickCount = 0;
let keyCount = 0;

const SCRIPT_VERSION = '14';

function getScriptPath(): string {
  if (scriptPath) return scriptPath;
  const tmpDir = path.join(process.env['USERPROFILE'] || 'C:\\Users\\default', '.umbra', 'tmp');
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
  scriptPath = path.join(tmpDir, 'input.ps1');
  return scriptPath;
}

function ensureScript(): void {
  const file = getScriptPath();
  try {
    const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : '';
    if (existing.includes(`#umbra-input-v${SCRIPT_VERSION}`)) return;
  } catch { }
  fs.writeFileSync(file, PS_SCRIPT, 'utf-8');
}

function run(args: string[]): string {
  ensureScript();
  const quoted = args.map(a => `"${a.replace(/"/g, '`"')}"`).join(' ');
  return execSync(
    `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${getScriptPath()}" ${quoted}`,
    { timeout: 20000, encoding: 'utf-8', windowsHide: true, maxBuffer: 1024 * 1024 },
  ).trim();
}

function safeRun(args: string[]): boolean {
  try {
    run(args);
    return true;
  } catch {
    return false;
  }
}

export function sendClick(x: number, y: number, button: number): void {
  clickCount++;
  safeRun(['click', String(Math.round(x)), String(Math.round(y)), String(button)]);
}

export function sendMouseMove(x: number, y: number): void {
  safeRun(['move', String(Math.round(x)), String(Math.round(y))]);
}

export function sendScroll(x: number, y: number, delta: number): void {
  safeRun(['scroll', String(Math.round(x)), String(Math.round(y)), String(Math.round(delta))]);
}

export function sendKey(key: string): void {
  keyCount++;
  safeRun(['key', key]);
}

export function sendHotkey(chord: string): void {
  safeRun(['hotkey', chord]);
}

export function createVirtualDesktop(): boolean {
  return safeRun(['hotkey', 'Win+Ctrl+D']);
}

export function switchVirtualDesktop(dir: 'left' | 'right'): boolean {
  return safeRun(['hotkey', dir === 'left' ? 'Win+Ctrl+ArrowLeft' : 'Win+Ctrl+ArrowRight']);
}

export function typeText(text: string): void {
  keyCount += text.length;
  safeRun(['type', text]);
}

export interface WindowRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function getWindowRect(titleOrProcess: string): WindowRect | null {
  try {
    const out = run(['windowrect', titleOrProcess]);
    const parts = out.split(',').map(p => parseInt(p.trim(), 10));
    if (parts.length === 4 && !parts.some(p => isNaN(p))) {
      return { x: parts[0], y: parts[1], width: parts[2] - parts[0], height: parts[3] - parts[1] };
    }
  } catch { }
  return null;
}

export function focusWindow(titleOrProcess: string): boolean {
  return safeRun(['windowfocus', titleOrProcess]);
}

export function moveWindow(titleOrProcess: string, x: number, y: number, width: number, height: number): boolean {
  return safeRun(['windowmove', titleOrProcess, String(x), String(y), String(width), String(height)]);
}

export function launchApp(command: string, args: string[] = []): boolean {
  return safeRun(['launch', command, ...args]);
}

export function getInputStats(): { clicks: number; keys: number } {
  return { clicks: clickCount, keys: keyCount };
}

export function resetInputStats(): void {
  clickCount = 0;
  keyCount = 0;
}

const PS_SCRIPT = `#umbra-input-v${SCRIPT_VERSION}
$ErrorActionPreference = 'Stop'
$dll = Join-Path $env:USERPROFILE '.umbra\\tmp\\InputW.dll'
if (-not (Test-Path $dll)) {
  $src = @'
using System;
using System.Runtime.InteropServices;
namespace Win32 {
  public class InputW {
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, UIntPtr dwExtraInfo);
    [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
    [DllImport("user32.dll")] public static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);
    [DllImport("user32.dll")] public static extern IntPtr FindWindow(string cls, string title);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
    [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr hWnd, int x, int y, int w, int h, bool repaint);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int cmd);
    [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();

    public const uint INPUT_KEYBOARD = 1;
    public const uint KEYEVENTF_KEYUP = 0x0002;
    public const uint KEYEVENTF_UNICODE = 0x0004;

    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L; public int T; public int R; public int B; }
    [StructLayout(LayoutKind.Explicit)] public struct INPUTUNION {
      [FieldOffset(0)] public KEYBDINPUT ki;
      [FieldOffset(0)] public MOUSEINPUT mi;
    }
    [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public UIntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public UIntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public INPUTUNION u; }
    public static readonly int INPUT_SIZE = Marshal.SizeOf(typeof(INPUT));

    static uint Check(uint sent, uint expected) {
      if (sent != expected) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
      return sent;
    }

    public static uint SendUnicode(string text) {
      var arr = new INPUT[text.Length * 2];
      for (int i = 0; i < text.Length; i++) {
        ushort c = text[i];
        arr[i * 2] = new INPUT { type = INPUT_KEYBOARD, u = new INPUTUNION { ki = new KEYBDINPUT { wVk = 0, wScan = c, dwFlags = KEYEVENTF_UNICODE, time = 0, dwExtraInfo = UIntPtr.Zero } } };
        arr[i * 2 + 1] = new INPUT { type = INPUT_KEYBOARD, u = new INPUTUNION { ki = new KEYBDINPUT { wVk = 0, wScan = c, dwFlags = KEYEVENTF_UNICODE | KEYEVENTF_KEYUP, time = 0, dwExtraInfo = UIntPtr.Zero } } };
      }
      return Check(SendInput((uint)arr.Length, arr, INPUT_SIZE), (uint)arr.Length);
    }

    public static uint SendKeyPress(ushort vk) {
      var arr = new INPUT[2];
      arr[0] = new INPUT { type = INPUT_KEYBOARD, u = new INPUTUNION { ki = new KEYBDINPUT { wVk = vk, wScan = 0, dwFlags = 0, time = 0, dwExtraInfo = UIntPtr.Zero } } };
      arr[1] = new INPUT { type = INPUT_KEYBOARD, u = new INPUTUNION { ki = new KEYBDINPUT { wVk = vk, wScan = 0, dwFlags = KEYEVENTF_KEYUP, time = 0, dwExtraInfo = UIntPtr.Zero } } };
      return Check(SendInput(2, arr, INPUT_SIZE), 2);
    }

    public static uint SendHotkey(ushort[] vks) {
      var arr = new INPUT[vks.Length * 2];
      for (int i = 0; i < vks.Length; i++) {
        arr[i] = new INPUT { type = INPUT_KEYBOARD, u = new INPUTUNION { ki = new KEYBDINPUT { wVk = vks[i], wScan = 0, dwFlags = 0, time = 0, dwExtraInfo = UIntPtr.Zero } } };
        arr[vks.Length + i] = new INPUT { type = INPUT_KEYBOARD, u = new INPUTUNION { ki = new KEYBDINPUT { wVk = vks[vks.Length - 1 - i], wScan = 0, dwFlags = KEYEVENTF_KEYUP, time = 0, dwExtraInfo = UIntPtr.Zero } } };
      }
      return Check(SendInput((uint)arr.Length, arr, INPUT_SIZE), (uint)arr.Length);
    }
  }
}
'@
  try {
    Add-Type -TypeDefinition $src -OutputAssembly $dll -ErrorAction Stop
  } catch {
    Add-Type -TypeDefinition $src
  }
} else {
  try { Add-Type -Path $dll } catch { }
}

$MOUSEEVENTF_LEFTDOWN = 0x0002
$MOUSEEVENTF_LEFTUP = 0x0004
$MOUSEEVENTF_RIGHTDOWN = 0x0008
$MOUSEEVENTF_RIGHTUP = 0x0010
$MOUSEEVENTF_MIDDLEDOWN = 0x0020
$MOUSEEVENTF_MIDDLEUP = 0x0040
$MOUSEEVENTF_WHEEL = 0x0800
$KEYEVENTF_KEYUP = 0x0002
$KEYEVENTF_UNICODE = 0x0004

function Find-TargetWindow($name) {
  $h = [Win32.InputW]::FindWindow($null, $name)
  if ($h -eq [IntPtr]::Zero) {
    $procs = Get-Process -Name $name -ErrorAction SilentlyContinue
    foreach ($p in $procs) {
      if ($p.MainWindowHandle -ne [IntPtr]::Zero) { $h = $p.MainWindowHandle; break }
    }
  }
  return $h
}

$cmd = $args[0]
switch ($cmd) {
  'click' {
    $x = [int]$args[1]; $y = [int]$args[2]; $b = [int]$args[3]
    [Win32.InputW]::SetCursorPos($x, $y) | Out-Null
    Start-Sleep -Milliseconds 30
    $down = $MOUSEEVENTF_LEFTDOWN; $up = $MOUSEEVENTF_LEFTUP
    if ($b -eq 2) { $down = $MOUSEEVENTF_RIGHTDOWN; $up = $MOUSEEVENTF_RIGHTUP }
    elseif ($b -eq 1) { $down = $MOUSEEVENTF_MIDDLEDOWN; $up = $MOUSEEVENTF_MIDDLEUP }
    [Win32.InputW]::mouse_event($down, 0, 0, 0, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 50
    [Win32.InputW]::mouse_event($up, 0, 0, 0, [UIntPtr]::Zero)
  }
  'move' {
    [Win32.InputW]::SetCursorPos([int]$args[1], [int]$args[2]) | Out-Null
  }
  'scroll' {
    $x = [int]$args[1]; $y = [int]$args[2]; $delta = [int]$args[3]
    [Win32.InputW]::SetCursorPos($x, $y) | Out-Null
    $steps = [Math]::Max(1, [Math]::Abs($delta) / 100)
    $wheel = if ($delta -lt 0) { 120 } else { -120 }
    for ($i = 0; $i -lt $steps; $i++) {
      [Win32.InputW]::mouse_event($MOUSEEVENTF_WHEEL, 0, 0, $wheel, [UIntPtr]::Zero)
      if ($steps -gt 1) { Start-Sleep -Milliseconds 20 }
    }
  }
  'key' {
    $vkMap = @{
      'Enter'=13; 'Return'=13; 'Escape'=27; 'Esc'=27; 'Tab'=9; 'Space'=32;
      'Backspace'=8; 'Delete'=46; 'Del'=46; 'Home'=36; 'End'=35;
      'PageUp'=33; 'PageDown'=34; 'ArrowUp'=38; 'Up'=38; 'ArrowDown'=40; 'Down'=40;
      'ArrowLeft'=37; 'Left'=37; 'ArrowRight'=39; 'Right'=39;
      'F1'=112;'F2'=113;'F3'=114;'F4'=115;'F5'=116;'F6'=117;'F7'=118;'F8'=119;'F9'=120;'F10'=121;'F11'=122;'F12'=123;
      'Ctrl'=17; 'Control'=17; 'Shift'=16; 'Alt'=18; 'Win'=91; 'LWin'=91;
      'A'=65;'B'=66;'C'=67;'D'=68;'E'=69;'F'=70;'G'=71;'H'=72;'I'=73;'J'=74;'K'=75;'L'=76;'M'=77;'N'=78;'O'=79;'P'=80;'Q'=81;'R'=82;'S'=83;'T'=84;'U'=85;'V'=86;'W'=87;'X'=88;'Y'=89;'Z'=90;
      '0'=48;'1'=49;'2'=50;'3'=51;'4'=52;'5'=53;'6'=54;'7'=55;'8'=56;'9'=57
    }
    $key = $args[1]
    if ($key -like '*+*') {
      $parts = $key -split '[+]'
      $vks = New-Object System.Collections.Generic.List[uint16]
      $lastVk = 0
      foreach ($p in $parts) {
        $vk = [uint16]$vkMap[$p]
        if ($vk -eq 17 -or $vk -eq 16 -or $vk -eq 18) { $vks.Add($vk) }
        else { $lastVk = $vk }
      }
      if ($lastVk -eq 0) { exit 1 }
      $vks.Add($lastVk)
      [Win32.InputW]::SendHotkey($vks.ToArray()) | Out-Null
    } else {
      $vk = [uint16]$vkMap[$key]
      if ($vk -eq 0) { $vk = [uint16][int][char]::ToUpper([string]$key[0]) }
      if ($vk -eq 0) { exit 1 }
      [Win32.InputW]::SendKeyPress($vk) | Out-Null
    }
  }
  'hotkey' {
    $parts = ($args[1]) -split '[+]'
    $vkMap = @{
      'Ctrl'=17; 'Control'=17; 'Shift'=16; 'Alt'=18; 'Win'=91; 'LWin'=91;
      'Enter'=13; 'Return'=13; 'Escape'=27; 'Esc'=27; 'Tab'=9; 'Space'=32;
      'Backspace'=8; 'Delete'=46; 'Del'=46; 'Home'=36; 'End'=35;
      'PageUp'=33; 'PageDown'=34; 'ArrowUp'=38; 'Up'=38; 'ArrowDown'=40; 'Down'=40;
      'ArrowLeft'=37; 'Left'=37; 'ArrowRight'=39; 'Right'=39;
      'F1'=112;'F2'=113;'F3'=114;'F4'=115;'F5'=116;'F6'=117;'F7'=118;'F8'=119;'F9'=120;'F10'=121;'F11'=122;'F12'=123;
      'A'=65;'B'=66;'C'=67;'D'=68;'E'=69;'F'=70;'G'=71;'H'=72;'I'=73;'J'=74;'K'=75;'L'=76;'M'=77;'N'=78;'O'=79;'P'=80;'Q'=81;'R'=82;'S'=83;'T'=84;'U'=85;'V'=86;'W'=87;'X'=88;'Y'=89;'Z'=90;
      '0'=48;'1'=49;'2'=50;'3'=51;'4'=52;'5'=53;'6'=54;'7'=55;'8'=56;'9'=57
    }
    $vks = New-Object System.Collections.Generic.List[uint16]
    $lastVk = 0
    foreach ($p in $parts) {
      $vk = [uint16]$vkMap[$p]
      if ($vk -eq 0 -and $p.Length -eq 1) { $vk = [uint16][int][char]::ToUpper($p) }
      if ($vk -eq 17 -or $vk -eq 16 -or $vk -eq 18 -or $vk -eq 91) { $vks.Add($vk) }
      elseif ($vk -ne 0) { $lastVk = $vk }
    }
    if ($lastVk -ne 0) { $vks.Add($lastVk) }
    if ($vks.Count -gt 0) { [Win32.InputW]::SendHotkey($vks.ToArray()) | Out-Null }
  }
  'type' {
    $text = $args[1]
    $old = $null
    try { $old = Get-Clipboard -Raw -ErrorAction Stop } catch { }
    try {
      Set-Clipboard -Value $text -ErrorAction Stop
    } catch {
      $chunk = 6
      for ($i = 0; $i -lt $text.Length; $i += $chunk) {
        $len = [Math]::Min($chunk, $text.Length - $i)
        [Win32.InputW]::SendUnicode($text.Substring($i, $len)) | Out-Null
        Start-Sleep -Milliseconds 120
      }
      exit 0
    }
    [Win32.InputW]::SendHotkey([uint16[]]@(17, 86)) | Out-Null
    Start-Sleep -Milliseconds 500
    if ($null -ne $old -and $old -ne '') {
      try { Set-Clipboard -Value $old } catch { }
    }
  }
  'windowfocus' {
    $h = Find-TargetWindow $args[1]
    if ($h -eq [IntPtr]::Zero) { exit 1 }
    if ([Win32.InputW]::IsIconic($h)) { [Win32.InputW]::ShowWindow($h, 9) | Out-Null }
    [Win32.InputW]::keybd_event(18, 0, 0, [UIntPtr]::Zero)
    [Win32.InputW]::keybd_event(18, 0, $KEYEVENTF_KEYUP, [UIntPtr]::Zero)
    [Win32.InputW]::SetWindowPos($h, [IntPtr](-1), 0, 0, 0, 0, 0x0003) | Out-Null
    [Win32.InputW]::SetWindowPos($h, [IntPtr](-2), 0, 0, 0, 0, 0x0003) | Out-Null
    [Win32.InputW]::SetForegroundWindow($h) | Out-Null
    Start-Sleep -Milliseconds 250
    if ([Win32.InputW]::GetForegroundWindow() -ne $h) {
      [Win32.InputW]::keybd_event(18, 0, 0, [UIntPtr]::Zero)
      [Win32.InputW]::keybd_event(18, 0, $KEYEVENTF_KEYUP, [UIntPtr]::Zero)
      [Win32.InputW]::SetForegroundWindow($h) | Out-Null
      Start-Sleep -Milliseconds 250
    }
    if ([Win32.InputW]::GetForegroundWindow() -ne $h) { exit 1 }
  }
  'windowmove' {
    $h = Find-TargetWindow $args[1]
    if ($h -eq [IntPtr]::Zero) { exit 1 }
    [Win32.InputW]::MoveWindow($h, [int]$args[2], [int]$args[3], [int]$args[4], [int]$args[5], $true) | Out-Null
  }
  'windowrect' {
    $h = Find-TargetWindow $args[1]
    if ($h -eq [IntPtr]::Zero) { exit 1 }
    $r = New-Object 'Win32.InputW+RECT'
    [Win32.InputW]::GetWindowRect($h, [ref]$r) | Out-Null
    Write-Output ("{0},{1},{2},{3}" -f $r.L, $r.T, $r.R, $r.B)
  }
  'launch' {
    $cmd2 = $args[1]
    if ($args.Count -gt 2) {
      $cmdArgs = @($args[2..($args.Count - 1)])
      Start-Process -FilePath $cmd2 -ArgumentList $cmdArgs -ErrorAction SilentlyContinue | Out-Null
    } else {
      Start-Process -FilePath $cmd2 -ErrorAction SilentlyContinue | Out-Null
    }
  }
  default { exit 1 }
}
`;
