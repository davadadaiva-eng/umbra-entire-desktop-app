/**
 * MicRecorder — captures the default Windows microphone to a WAV buffer for
 * push-to-talk ("tap to listen").
 *
 * Push-to-talk must hear the USER, not the system: the meeting loopback
 * recorder hears whatever the PC is *playing*, so it is the wrong source for
 * a voice command. This recorder uses waveIn (the classic Win32 capture API)
 * through an embedded-C# PowerShell script, mirrors LoopbackRecorder's
 * best-effort pattern, and satisfies the PushToTalkRecorder contract
 * (start() / stop(): Promise<Buffer>).
 *
 * Windows-only, dependency-free: Add-Type compiles the C# once (cached,
 * versioned), and each capture is a short PowerShell child that writes a temp
 * WAV file. stop() signals the child via a sentinel file, so the child
 * finalizes the WAV header before exiting — no truncated clips.
 */
import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getLogger } from '../Logger';

const SCRIPT_VERSION = '1';

const PS_SCRIPT = `#umbra-mic-recorder-v${'1'}
param(
  [string]$WavPath,
  [int]$MaxSeconds = 30
)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;

public static class MicRecorderNative
{
    [DllImport("winmm.dll")]
    private static extern int waveInOpen(out IntPtr hwi, uint uDeviceID, WAVEFORMATEX pwfx, IntPtr dwCallback, IntPtr dwInstance, uint dwFlags);
    [DllImport("winmm.dll")]
    private static extern int waveInStart(IntPtr hwi);
    [DllImport("winmm.dll")]
    private static extern int waveInStop(IntPtr hwi);
    [DllImport("winmm.dll")]
    private static extern int waveInClose(IntPtr hwi);
    [DllImport("winmm.dll")]
    private static extern int waveInPrepareHeader(IntPtr hwi, ref WAVEHDR pwh, uint cbwh);
    [DllImport("winmm.dll")]
    private static extern int waveInUnprepareHeader(IntPtr hwi, ref WAVEHDR pwh, uint cbwh);
    [DllImport("winmm.dll")]
    private static extern int waveInAddBuffer(IntPtr hwi, ref WAVEHDR pwh, uint cbwh);

    [StructLayout(LayoutKind.Sequential)]
    private struct WAVEFORMATEX
    {
        public ushort wFormatTag;
        public ushort nChannels;
        public uint nSamplesPerSec;
        public uint nAvgBytesPerSec;
        public ushort nBlockAlign;
        public ushort wBitsPerSample;
        public ushort cbSize;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct WAVEHDR
    {
        public IntPtr lpData;
        public uint dwBufferLength;
        public uint dwBytesRecorded;
        public IntPtr dwUser;
        public uint dwFlags;
        public uint dwLoops;
        public IntPtr lpNext;
        public IntPtr reserved;
    }

    private const uint WAVE_MAPPER = 0xFFFFFFFF;
    private const uint CALLBACK_NULL = 0x00000000;

    public static void Record(string wavPath, int maxSeconds)
    {
        var fmt = new WAVEFORMATEX();
        fmt.wFormatTag = 1;         // PCM
        fmt.nChannels = 1;          // mono
        fmt.nSamplesPerSec = 16000; // 16 kHz
        fmt.wBitsPerSample = 16;
        fmt.nBlockAlign = (ushort)(fmt.nChannels * 2);
        fmt.nAvgBytesPerSec = fmt.nSamplesPerSec * fmt.nBlockAlign;

        IntPtr hwi;
        if (waveInOpen(out hwi, WAVE_MAPPER, fmt, IntPtr.Zero, IntPtr.Zero, CALLBACK_NULL) != 0)
            throw new Exception("Mic: no default capture device (waveInOpen failed)");

        try
        {
            uint maxBytes = (uint)((ulong)fmt.nSamplesPerSec * fmt.nBlockAlign * (ulong)Math.Max(1, maxSeconds));
            var data = new byte[maxBytes];
            var hdr = new WAVEHDR();
            hdr.lpData = Marshal.AllocHGlobal(data.Length);
            hdr.dwBufferLength = (uint)data.Length;
            try
            {
                if (waveInPrepareHeader(hwi, ref hdr, (uint)Marshal.SizeOf(typeof(WAVEHDR))) != 0)
                    throw new Exception("Mic: waveInPrepareHeader failed");
                if (waveInAddBuffer(hwi, ref hdr, (uint)Marshal.SizeOf(typeof(WAVEHDR))) != 0)
                    throw new Exception("Mic: waveInAddBuffer failed");
                if (waveInStart(hwi) != 0)
                    throw new Exception("Mic: waveInStart failed");

                // Capture until the stop sentinel appears (written by the Node
                // side when the hotkey is released) or the safety cap expires.
                var sw = System.Diagnostics.Stopwatch.StartNew();
                while (sw.Elapsed.TotalSeconds < maxSeconds && !File.Exists(wavPath + ".stop"))
                {
                    Thread.Sleep(50);
                }

                waveInStop(hwi);
                Thread.Sleep(100); // let the last buffer settle
                waveInUnprepareHeader(hwi, ref hdr, (uint)Marshal.SizeOf(typeof(WAVEHDR)));

                uint recorded = Math.Min(hdr.dwBytesRecorded, (uint)data.Length);
                Marshal.Copy(hdr.lpData, data, 0, (int)recorded);

                // RIFF/WAVE header + PCM payload.
                using (var outFs = new FileStream(wavPath, FileMode.Create, FileAccess.Write))
                using (var bw = new BinaryWriter(outFs))
                {
                    bw.Write(System.Text.Encoding.ASCII.GetBytes("RIFF"));
                    bw.Write(36 + (int)recorded);
                    bw.Write(System.Text.Encoding.ASCII.GetBytes("WAVE"));
                    bw.Write(System.Text.Encoding.ASCII.GetBytes("fmt "));
                    bw.Write(16);
                    bw.Write((ushort)1);
                    bw.Write(fmt.nChannels);
                    bw.Write(fmt.nSamplesPerSec);
                    bw.Write(fmt.nAvgBytesPerSec);
                    bw.Write(fmt.nBlockAlign);
                    bw.Write(fmt.wBitsPerSample);
                    bw.Write(System.Text.Encoding.ASCII.GetBytes("data"));
                    bw.Write((int)recorded);
                    bw.Write(data, 0, (int)recorded);
                }
            }
            finally
            {
                if (hdr.lpData != IntPtr.Zero) Marshal.FreeHGlobal(hdr.lpData);
            }
        }
        finally
        {
            waveInClose(hwi);
        }
    }
}
'@

[MicRecorderNative]::Record($WavPath, $MaxSeconds)
`;

export interface MicRecorderOptions {
  /** Safety cap for a single capture (default 30s). */
  maxSeconds?: number;
  /** Temp dir for WAV output (default os.tmpdir()). */
  tmpDir?: string;
  /** Injectable process spawner for tests (defaults to child_process.spawn). */
  spawnFn?: typeof spawn;
}

/**
 * Satisfies the PushToTalkRecorder contract: start() begins waveIn capture,
 * stop() signals the child to finalize and returns the WAV buffer. When no
 * capture device exists the child exits early and stop() yields an empty
 * buffer — PushToTalkService already treats that as "nothing heard".
 */
export class MicRecorder {
  private maxSeconds: number;
  private tmpDir: string;
  private spawnFn: typeof spawn;
  private scriptPath: string;
  private child: ChildProcess | null = null;
  private wavPath: string = '';

  constructor(options: MicRecorderOptions = {}) {
    this.maxSeconds = options.maxSeconds ?? 30;
    this.tmpDir = options.tmpDir ?? os.tmpdir();
    this.spawnFn = options.spawnFn ?? spawn;
    this.scriptPath = path.join(this.tmpDir, `umbra-mic-recorder-v${SCRIPT_VERSION}.ps1`);
    this.ensureScript();
  }

  private ensureScript(): void {
    try {
      const existing = fs.existsSync(this.scriptPath) ? fs.readFileSync(this.scriptPath, 'utf-8') : '';
      if (existing.includes(`#umbra-mic-recorder-v${SCRIPT_VERSION}`)) return;
    } catch { }
    fs.writeFileSync(this.scriptPath, PS_SCRIPT, 'utf-8');
  }

  /** Begin microphone capture (no-op while already capturing). */
  start(): Promise<void> {
    if (this.child) return Promise.resolve();
    this.wavPath = path.join(this.tmpDir, `umbra-ptt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.wav`);
    const stopFile = this.wavPath + '.stop';
    try { if (fs.existsSync(stopFile)) fs.unlinkSync(stopFile); } catch { }

    return new Promise((resolve) => {
      const child = this.spawnFn('powershell', [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', this.scriptPath,
        '-WavPath', this.wavPath,
        '-MaxSeconds', String(this.maxSeconds),
      ], { windowsHide: true, stdio: 'ignore' });
      this.child = child;
      child.on('error', (err) => {
        if (this.child === child) this.child = null;
        getLogger().warn({ err }, 'MicRecorder: capture failed to start');
      });
      child.on('exit', () => {
        if (this.child === child) this.child = null;
      });
      resolve();
    });
  }

  /** Stop capture and return the recorded WAV (empty buffer when nothing heard). */
  stop(): Promise<Buffer> {
    const child = this.child;
    const wavPath = this.wavPath;
    this.child = null;
    if (!child) return Promise.resolve(Buffer.alloc(0));

    // Sentinal: the PowerShell loop polls for this file and finalizes the WAV.
    try { fs.writeFileSync(wavPath + '.stop', 'stop', 'utf-8'); } catch { }

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        try { child.kill(); } catch { }
        resolve(this.readWav(wavPath));
      }, this.maxSeconds * 1000 + 5000);
      child.on('exit', () => {
        clearTimeout(timer);
        resolve(this.readWav(wavPath));
      });
    });
  }

  private readWav(wavPath: string): Buffer {
    try {
      const buf = fs.readFileSync(wavPath);
      try { fs.unlinkSync(wavPath); } catch { }
      try { fs.unlinkSync(wavPath + '.stop'); } catch { }
      return buf;
    } catch {
      return Buffer.alloc(0);
    }
  }
}
