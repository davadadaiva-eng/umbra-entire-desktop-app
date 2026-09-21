/**
 * LoopbackRecorder — captures Windows system audio (what the PC is playing,
 * e.g. a Zoom/Meet/Teams call) to a WAV file via WASAPI loopback.
 *
 * This is the "hearing" half of the meeting feature: while Umbra attends a
 * meeting, this records chunks of the meeting audio and hands them to the STT
 * engine so the transcript (and the action items) are derived from real audio.
 *
 * Windows-only, best-effort: loopback capture uses the default render device.
 * On machines where loopback is blocked (some audio drivers), the meeting
 * companion degrades gracefully — you can route system audio to the mic via
 * VB-Cable / Stereo Mix, or feed audio through the API instead.
 */
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { getLogger } from '../Logger';

const CS_SOURCE = `using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;

public static class LoopbackRecorder
{
    [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
    private class MMDeviceEnumeratorComObject { }

    private enum EDataFlow { eRender = 0, eCapture = 1, eAll = 2 }
    private enum ERole { eConsole = 0, eMultimedia = 1, eCommunications = 2 }
    private enum AUDCLNT_SHAREMODE { SHARED = 0, EXCLUSIVE = 1 }

    [Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IMMDeviceEnumerator
    {
        int NotImpl1();
        [PreserveSig] int GetDefaultAudioEndpoint(EDataFlow dataFlow, ERole role, out IMMDevice ppDevice);
        int NotImpl2();
        int NotImpl3();
        int NotImpl4();
    }

    [Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IMMDevice
    {
        [PreserveSig] int Activate(ref Guid iid, int dwClsCtx, IntPtr pActivationParams, [MarshalAs(UnmanagedType.IUnknown)] out object ppInterface);
        int NotImpl1();
        int NotImpl2();
        int NotImpl3();
    }

    [Guid("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IAudioClient
    {
        [PreserveSig] int Initialize(AUDCLNT_SHAREMODE shareMode, int streamFlags, long hnsBufferDuration, long hnsPeriodicity, IntPtr pFormat, ref Guid audioSessionGuid);
        [PreserveSig] int GetBufferSize(out int numBufferFrames);
        int NotImpl1();
        int NotImpl2();
        int NotImpl3();
        int NotImpl4();
        [PreserveSig] int GetMixFormat(out IntPtr ppFormat);
        int NotImpl5();
        [PreserveSig] int Start();
        [PreserveSig] int Stop();
        int NotImpl6();
        int NotImpl7();
        [PreserveSig] int GetService(ref Guid riid, [MarshalAs(UnmanagedType.IUnknown)] out object ppv);
    }

    [Guid("C8ADBD64-E71E-48a0-A4DE-185C395CD317"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IAudioCaptureClient
    {
        [PreserveSig] int GetBuffer(out IntPtr data, out int numFramesToRead, out int dwFlags, out long pu64DevicePosition, out long pu64QPCPosition);
        [PreserveSig] int ReleaseBuffer(int numFramesRead);
        [PreserveSig] int GetNextPacketSize(out int numFramesInNextPacket);
    }

    [StructLayout(LayoutKind.Sequential, Pack = 2)]
    private struct WaveFormat
    {
        public ushort wFormatTag;
        public ushort nChannels;
        public uint nSamplesPerSec;
        public uint nAvgBytesPerSec;
        public ushort nBlockAlign;
        public ushort wBitsPerSample;
        public ushort cbSize;
    }

    public static void Record(string path, int seconds)
    {
        var enumerator = (IMMDeviceEnumerator)new MMDeviceEnumeratorComObject();
        IMMDevice device;
        if (enumerator.GetDefaultAudioEndpoint(EDataFlow.eRender, ERole.eMultimedia, out device) != 0)
            throw new Exception("Loopback: no default render endpoint");

        Guid iidIAC = new Guid("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2");
        object audioClientObj;
        if (device.Activate(ref iidIAC, 1, IntPtr.Zero, out audioClientObj) != 0)
            throw new Exception("Loopback: audio client activation failed");
        var audioClient = (IAudioClient)audioClientObj;

        IntPtr fmtPtr;
        if (audioClient.GetMixFormat(out fmtPtr) != 0)
            throw new Exception("Loopback: GetMixFormat failed");
        var fmt = (WaveFormat)Marshal.PtrToStructure(fmtPtr, typeof(WaveFormat));

        Guid guidEmpty = Guid.Empty;
        int hr = audioClient.Initialize(AUDCLNT_SHAREMODE.SHARED, 0x00020000 /*LOOPBACK*/, 0, 0, fmtPtr, ref guidEmpty);
        if (hr != 0)
            throw new Exception("Loopback: initialize failed 0x" + hr.ToString("X"));

        Guid iidCapture = new Guid("C8ADBD64-E71E-48a0-A4DE-185C395CD317");
        object captureObj;
        if (audioClient.GetService(ref iidCapture, out captureObj) != 0)
            throw new Exception("Loopback: capture client failed");
        var capture = (IAudioCaptureClient)captureObj;

        int bufferSize;
        audioClient.GetBufferSize(out bufferSize);
        audioClient.Start();

        int blockAlign = fmt.nBlockAlign;
        int sampleRate = (int)fmt.nSamplesPerSec;
        int channels = fmt.nChannels;
        int bitsPerSample = fmt.wBitsPerSample;

        long totalFrames = (long)sampleRate * seconds;
        long framesRead = 0;
        var ms = new MemoryStream();
        var sw = System.Diagnostics.Stopwatch.StartNew();
        while (sw.ElapsedMilliseconds < seconds * 1000L && framesRead < totalFrames)
        {
            Thread.Sleep(20);
            int packetSize;
            if (capture.GetNextPacketSize(out packetSize) != 0) continue;
            while (packetSize > 0 && framesRead < totalFrames)
            {
                IntPtr buf;
                int frames;
                int dwFlags;
                long pos, qpc;
                int gb = capture.GetBuffer(out buf, out frames, out dwFlags, out pos, out qpc);
                if (gb == 0x08890002) { capture.ReleaseBuffer(0); break; } // AUDCLNT_S_BUFFER_EMPTY
                if (gb != 0) break;
                if ((dwFlags & 0x1) == 0) // skip AUDCLNT_BUFFERFLAGS_SILENT
                {
                    int bytesToCopy = frames * blockAlign;
                    var chunk = new byte[bytesToCopy];
                    Marshal.Copy(buf, chunk, 0, bytesToCopy);
                    ms.Write(chunk, 0, bytesToCopy);
                    framesRead += frames;
                }
                capture.ReleaseBuffer(frames);
                capture.GetNextPacketSize(out packetSize);
            }
        }
        audioClient.Stop();

        using (var fs = new FileStream(path, FileMode.Create))
        {
            WriteWavHeader(fs, ms.Length, sampleRate, channels, bitsPerSample);
            ms.Position = 0;
            ms.CopyTo(fs);
        }
        Marshal.FreeCoTaskMem(fmtPtr);
    }

    private static void WriteWavHeader(Stream s, long dataLength, int sampleRate, int channels, int bitsPerSample)
    {
        int blockAlign = channels * bitsPerSample / 8;
        long byteRate = sampleRate * (long)blockAlign;
        var bw = new BinaryWriter(s);
        bw.Write(new char[] { 'R','I','F','F' });
        bw.Write((int)(36 + dataLength));
        bw.Write(new char[] { 'W','A','V','E' });
        bw.Write(new char[] { 'f','m','t',' ' });
        bw.Write(16);
        bw.Write((short)1);
        bw.Write((short)channels);
        bw.Write(sampleRate);
        bw.Write((int)byteRate);
        bw.Write((short)blockAlign);
        bw.Write((short)bitsPerSample);
        bw.Write(new char[] { 'd','a','t','a' });
        bw.Write((int)dataLength);
    }
}`;

const PS_RECORD_SCRIPT = `param([string]$OutPath, [int]$Seconds)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
__CS_SOURCE__
'@
[LoopbackRecorder]::Record($OutPath, $Seconds)`;

export interface LoopbackRecorderOptions {
  dataDir: string;
}

export class LoopbackRecorder {
  private dataDir: string;
  private tmpDir: string;

  constructor(options: LoopbackRecorderOptions) {
    this.dataDir = options.dataDir;
    this.tmpDir = path.join(options.dataDir, 'tmp');
  }

  /** Whether this platform can attempt loopback capture. */
  get available(): boolean {
    return process.platform === 'win32';
  }

  /** Record `seconds` of system audio to a WAV file; returns the file buffer. */
  async record(seconds: number): Promise<Buffer> {
    if (!this.available) {
      throw new Error('Loopback audio capture is Windows-only');
    }
    fs.mkdirSync(this.tmpDir, { recursive: true });
    const outPath = path.join(this.tmpDir, `loopback-${Date.now()}.wav`);
    const psPath = path.join(this.tmpDir, 'loopback-record.ps1');
    fs.writeFileSync(psPath, PS_RECORD_SCRIPT.replace('__CS_SOURCE__', CS_SOURCE), 'utf-8');

    try {
      execSync(
        `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${psPath}" "${outPath}" ${seconds}`,
        { timeout: (seconds + 10) * 1000, encoding: 'utf-8', windowsHide: true, maxBuffer: 1024 * 1024 },
      );
    } catch (err: any) {
      getLogger().warn({ err: (err.stderr || err.message || '').toString().slice(0, 300) }, 'Loopback capture failed');
      throw new Error(
        'Loopback capture failed. Enable "Stereo Mix" in sound settings, or install VB-Cable and route system audio to the mic, then retry.',
      );
    }

    if (!fs.existsSync(outPath)) {
      throw new Error('Loopback capture produced no audio file');
    }
    const buffer = fs.readFileSync(outPath);
    try { fs.unlinkSync(outPath); } catch { }
    return buffer;
  }
}
