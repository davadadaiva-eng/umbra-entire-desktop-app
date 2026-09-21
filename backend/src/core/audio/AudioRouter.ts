/**
 * AudioRouter — routes synthesized speech to a specific Windows audio device
 * (a virtual audio cable) so a meeting actually *hears* Umbra, instead of the
 * sound playing only on the local speakers.
 *
 * How it works (Windows-only, dependency-free):
 *  - enumerate render/capture endpoints from the MMDevices registry keys
 *    (friendly names + endpoint IDs),
 *  - get/set the default endpoint via the undocumented IPolicyConfig COM
 *    interface (the same per-user "default device" the Sound control panel
 *    toggles — no admin needed),
 *  - play a WAV on a chosen device by temporarily switching the default render
 *    endpoint to it, playing via System.Media.SoundPlayer, then restoring the
 *    previous default.
 *
 * For a meeting: synthesize the reply to WAV, play it into the cable's render
 * side ("CABLE Input"), and set the meeting app's microphone to the cable's
 * capture side ("CABLE Output") once. Call participants then hear Umbra.
 */
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { getLogger } from '../Logger';

export interface AudioDevice {
  /** Endpoint id, e.g. "{0.0.0.00000000}.{guid}". */
  id: string;
  /** Friendly name shown in the Sound control panel. */
  name: string;
  flow: 'render' | 'capture';
  isDefault?: boolean;
}

export type AudioFlow = 'render' | 'capture';

const CS_SOURCE = `using System;
using System.Runtime.InteropServices;

[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
public class MMDeviceEnumeratorComObject { }

[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IMMDeviceEnumerator
{
    int NotImpl1();
    [PreserveSig] int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice ppDevice);
    int NotImpl2();
    int NotImpl3();
    int NotImpl4();
}

[Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IMMDevice
{
    int NotImpl1();
    int NotImpl2();
    [PreserveSig] int GetId([MarshalAs(UnmanagedType.LPWStr)] out string ppwstrId);
    int NotImpl3();
}

[ComImport, Guid("870af99c-171d-4f9e-af0d-e63df40c2bc9")]
public class CPolicyConfigClient { }

[Guid("f8679f50-850a-41cf-9c72-430f290290c8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IPolicyConfig
{
    int GetMixFormat(string deviceId, IntPtr format);
    int GetDeviceFormat(string deviceId, bool isDefault, IntPtr format);
    int ResetDeviceFormat(string deviceId);
    int SetDeviceFormat(string deviceId, IntPtr format, IntPtr endpointFormat);
    int GetProcessingPeriod(string deviceId, bool isDefault, IntPtr defaultPeriod, IntPtr minPeriod);
    int SetProcessingPeriod(string deviceId, IntPtr period);
    int GetShareMode(string deviceId, IntPtr mode);
    int SetShareMode(string deviceId, IntPtr mode);
    int GetPropertyValue(string deviceId, bool isStore, ref PROPERTYKEY key, out PROPVARIANT value);
    int SetPropertyValue(string deviceId, bool isStore, ref PROPERTYKEY key, ref PROPVARIANT value);
    int SetDefaultEndpoint(string deviceId, int role);
    int SetEndpointVisibility(string deviceId, bool visible);
}

[StructLayout(LayoutKind.Sequential)]
public struct PROPERTYKEY { public Guid fmtid; public uint pid; }

[StructLayout(LayoutKind.Sequential)]
public struct PROPVARIANT { public ushort vt; public ushort wReserved1; public ushort wReserved2; public ushort wReserved3; public IntPtr ptr; }

public static class AudioRouterNative
{
    // role 1 = eMultimedia (the "default device" on Windows 10/11).
    public static string GetDefault(int flow)
    {
        var enumerator = (IMMDeviceEnumerator)new MMDeviceEnumeratorComObject();
        IMMDevice device;
        if (enumerator.GetDefaultAudioEndpoint(flow, 1, out device) != 0)
            throw new Exception("No default audio endpoint");
        string id;
        if (device.GetId(out id) != 0)
            throw new Exception("GetId failed");
        return id;
    }

    public static void SetDefault(int flow, string id)
    {
        var policy = (IPolicyConfig)new CPolicyConfigClient();
        if (policy.SetDefaultEndpoint(id, 1) != 0)
            throw new Exception("SetDefaultEndpoint failed");
    }
}`;

const PS_ROUTER = `param(
  [Parameter(Mandatory=$true)][string]$Action,
  [string]$DeviceId = '',
  [string]$WavPath = '',
  [int]$Flow = 0
)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
__CS_SOURCE__
'@

function Get-Endpoints([int]$Flow) {
  $root = if ($Flow -eq 0) {
    'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\MMDevices\\Audio\\Render'
  } else {
    'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\MMDevices\\Audio\\Capture'
  }
  $defaultId = ''
  try { $defaultId = [AudioRouterNative]::GetDefault($Flow) } catch { }
  Get-ChildItem $root -ErrorAction SilentlyContinue | ForEach-Object {
    $name = $null
    try {
      $name = (Get-ItemProperty -Path $_.PSPath -ErrorAction SilentlyContinue).'{a45c254e-df1c-4efd-8020-67d146a850e0},2'
    } catch { }
    if (-not $name) {
      try {
        $name = (Get-ItemProperty -Path (Join-Path $_.PSPath 'Properties') -ErrorAction SilentlyContinue).'{a45c254e-df1c-4efd-8020-67d146a850e0},2'
      } catch { }
    }
    if (-not $name) {
      try {
        $name = (Get-ItemProperty -Path (Join-Path $_.PSPath 'Properties') -ErrorAction SilentlyContinue).'{026e516e-b814-414b-83cd-856d6fef4822},2'
      } catch { }
    }
    [PSCustomObject]@{
      id = $_.PSChildName
      name = [string]$name
      flow = if ($Flow -eq 0) { 'render' } else { 'capture' }
      isDefault = ($_.PSChildName -eq $defaultId)
    }
  }
}

switch ($Action) {
  'list' {
    @(Get-Endpoints 0) + @(Get-Endpoints 1) | ConvertTo-Json -Compress
  }
  'get-default' {
    [AudioRouterNative]::GetDefault($Flow)
  }
  'set-default' {
    [AudioRouterNative]::SetDefault($Flow, $DeviceId)
    'ok'
  }
  'play' {
    if (-not (Test-Path $WavPath)) { throw "WAV not found: $WavPath" }
    $saved = [AudioRouterNative]::GetDefault(0)
    try {
      if ($DeviceId -and $DeviceId -ne $saved) {
        [AudioRouterNative]::SetDefault(0, $DeviceId)
        Start-Sleep -Milliseconds 300
      }
      $player = New-Object System.Media.SoundPlayer
      $player.SoundLocation = $WavPath
      $player.PlaySync()
      'ok'
    } finally {
      if ($DeviceId -and $DeviceId -ne $saved) {
        [AudioRouterNative]::SetDefault(0, $saved)
      }
    }
  }
  default { throw "Unknown action: $Action" }
}`;

/** Parse the JSON emitted by the `list` action into AudioDevice objects. */
export function parseDeviceList(stdout: string): AudioDevice[] {
  const text = stdout.trim();
  if (!text) return [];
  try {
    const raw = JSON.parse(text);
    const arr = Array.isArray(raw) ? raw : [raw];
    return arr
      .filter(d => d && typeof d === 'object')
      .map(d => ({
        id: String(d.id ?? ''),
        name: String(d.name ?? ''),
        flow: d.flow === 'capture' ? 'capture' as const : 'render' as const,
        isDefault: d.isDefault === true || d.isDefault === 'True',
      }))
      .filter(d => d.id && d.name);
  } catch {
    return [];
  }
}

/** Whether a device name looks like a VB-Audio / Virtual Audio Cable endpoint. */
export function isCableDevice(device: AudioDevice): boolean {
  const n = device.name.toLowerCase();
  if (n.includes('vb-audio') || n.includes('vb-cable')) return true;
  if (!n.includes('cable')) return false;
  if (device.flow === 'render') return n.includes('input') || !n.includes('output');
  return n.includes('output');
}

/** Pick the cable endpoint of the given flow from a device list. */
export function findCable(devices: AudioDevice[], flow: AudioFlow): AudioDevice | null {
  return devices.find(d => d.flow === flow && isCableDevice(d)) ?? null;
}

export interface AudioRouterOptions {
  dataDir: string;
  /** Injectable runner for tests; returns the PowerShell stdout. */
  exec?: (cmd: string, args: string[], timeoutMs: number) => string;
}

export class AudioRouter {
  private dataDir: string;
  private tmpDir: string;
  private execFn?: (cmd: string, args: string[], timeoutMs: number) => string;

  constructor(options: AudioRouterOptions) {
    this.dataDir = options.dataDir;
    this.tmpDir = path.join(options.dataDir, 'tmp');
    this.execFn = options.exec;
  }

  /** Windows-only: the device switching + playback rely on SAPI/SoundPlayer + MMDevices. */
  get available(): boolean {
    return process.platform === 'win32';
  }

  /** List render and/or capture endpoints. */
  async listDevices(flow: AudioFlow | 'both' = 'both'): Promise<AudioDevice[]> {
    if (!this.available) return [];
    const stdout = this.run('list', {});
    const devices = parseDeviceList(stdout);
    return flow === 'both' ? devices : devices.filter(d => d.flow === flow);
  }

  /** Current default endpoint id for the flow (render/capture). */
  async getDefault(flow: AudioFlow): Promise<string | null> {
    if (!this.available) return null;
    try {
      const out = this.run('get-default', { flow });
      const id = out.trim();
      return id || null;
    } catch {
      return null;
    }
  }

  /** Set the default endpoint for the flow (per-user, no admin). */
  async setDefault(flow: AudioFlow, deviceId: string): Promise<void> {
    if (!this.available) throw new Error('Audio routing is Windows-only');
    this.run('set-default', { flow, deviceId });
  }

  /**
   * Play a WAV buffer. With no deviceId it plays on the current default
   * speakers; with a deviceId (e.g. a cable's "CABLE Input") it temporarily
   * switches the default render endpoint to that device, plays, and restores.
   */
  async play(wav: Buffer, deviceId?: string): Promise<void> {
    if (!this.available) throw new Error('Audio routing is Windows-only');
    if (!wav || wav.length === 0) throw new Error('Empty audio buffer');
    fs.mkdirSync(this.tmpDir, { recursive: true });
    const wavPath = path.join(this.tmpDir, `router-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.wav`);
    fs.writeFileSync(wavPath, wav);
    try {
      this.run('play', { deviceId: deviceId || '', wavPath });
      getLogger().info({ deviceId: deviceId || 'default' }, 'Audio played via router');
    } finally {
      try { fs.unlinkSync(wavPath); } catch { }
    }
  }

  /** Find the virtual cable render ("CABLE Input") / capture ("CABLE Output") endpoint. */
  async findCable(flow: AudioFlow): Promise<AudioDevice | null> {
    return findCable(await this.listDevices(flow), flow);
  }

  /** Run the embedded PowerShell router script and return its stdout. */
  private run(
    action: 'list' | 'get-default' | 'set-default' | 'play',
    args: { flow?: AudioFlow; deviceId?: string; wavPath?: string },
  ): string {
    fs.mkdirSync(this.tmpDir, { recursive: true });
    const psPath = path.join(this.tmpDir, 'audio-router.ps1');
    fs.writeFileSync(psPath, PS_ROUTER.replace('__CS_SOURCE__', CS_SOURCE), 'utf-8');

    const flowNum = args.flow === 'capture' ? 1 : 0;
    const psArgs = [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', `"${psPath}"`,
      `"${action}"`,
    ];
    psArgs.push(`"${args.deviceId ?? ''}"`);
    psArgs.push(`"${args.wavPath ?? ''}"`);
    psArgs.push(`${flowNum}`);

    const cmd = `powershell ${psArgs.join(' ')}`;
    const timeoutMs = action === 'play' ? 180000 : 20000;
    if (this.execFn) return this.execFn(cmd, psArgs, timeoutMs);
    try {
      return execSync(cmd, { timeout: timeoutMs, encoding: 'utf-8', windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
    } catch (err: any) {
      const detail = (err.stderr || err.message || '').toString().slice(0, 400);
      throw new Error(`Audio routing failed (${action}): ${detail || 'unknown error'}`);
    }
  }
}
