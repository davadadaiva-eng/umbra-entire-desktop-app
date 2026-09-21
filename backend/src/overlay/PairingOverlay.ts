/**
 * PairingOverlay — a small, always-on-top, frameless window parked near the
 * system tray that shows the phone/tablet pairing link and a live QR code.
 *
 * This is the "phone-home check": the PC announces itself on screen, and the
 * QR auto-refreshes so the payload never expires while the window is open
 * (pairing sessions live ~5 minutes). Windows-only — implemented with a
 * PowerShell WinForms window, the same native path ScreenCaptureNative uses.
 *
 * The Node side owns freshness: it regenerates the QR PNG from a fresh pairing
 * payload on an interval; the PowerShell window reloads that file on its own
 * timer. Loading the PNG through a MemoryStream releases the file lock so Node
 * can overwrite it.
 */
import * as fs from 'fs';
import * as path from 'path';
import { spawn, ChildProcess } from 'child_process';
import QRCode from 'qrcode';
import { getLogger } from '../core/Logger';

export interface PairingOverlayHandlers {
  /** Human-readable URL the phone/tablet opens (e.g. http://192.168.1.5:9443). */
  getLink: () => string;
  /** Fresh pairing payload JSON rendered into the QR code. */
  getPayloadJson: () => string;
}

const OVERLAY_PS = `param([string]$QrPath, [string]$Link, [string]$Title)

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$form = New-Object System.Windows.Forms.Form
$form.Text = $Title
$form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::None
$form.TopMost = $true
$form.ShowInTaskbar = $false
$form.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual
$form.Size = New-Object System.Drawing.Size(352, 470)
$screen = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
$form.Location = New-Object System.Drawing.Point(($screen.Right - $form.Width - 14), ($screen.Bottom - $form.Height - 14))

$title = New-Object System.Windows.Forms.Label
$title.Text = "Umbra OS - pair a device"
$title.Font = New-Object System.Drawing.Font("Segoe UI", 10, [System.Drawing.FontStyle]::Bold)
$title.Size = New-Object System.Drawing.Size(330, 22)
$title.Location = New-Object System.Drawing.Point(10, 8)
$form.Controls.Add($title)

$link = New-Object System.Windows.Forms.Label
$link.Text = $Link
$link.Font = New-Object System.Drawing.Font("Consolas", 9)
$link.ForeColor = [System.Drawing.Color]::DodgerBlue
$link.AutoSize = $false
$link.Size = New-Object System.Drawing.Size(330, 34)
$link.Location = New-Object System.Drawing.Point(10, 32)
$form.Controls.Add($link)

$pic = New-Object System.Windows.Forms.PictureBox
$pic.Size = New-Object System.Drawing.Size(320, 320)
$pic.Location = New-Object System.Drawing.Point(16, 72)
$pic.SizeMode = [System.Windows.Forms.PictureBoxSizeMode]::Zoom
$pic.BackColor = [System.Drawing.Color]::White
$form.Controls.Add($pic)

$hint = New-Object System.Windows.Forms.Label
$hint.Text = "On the same Wi-Fi, open the link or scan the QR. Auto-refreshes."
$hint.Font = New-Object System.Drawing.Font("Segoe UI", 8)
$hint.ForeColor = [System.Drawing.Color]::Gray
$hint.Size = New-Object System.Drawing.Size(330, 30)
$hint.Location = New-Object System.Drawing.Point(10, 398)
$form.Controls.Add($hint)

$close = New-Object System.Windows.Forms.Button
$close.Text = "Close"
$close.Size = New-Object System.Drawing.Size(90, 26)
$close.Location = New-Object System.Drawing.Point(126, 432)
$close.Add_Click({ $form.Close() })
$form.Controls.Add($close)

function Load-Qr {
  if (Test-Path $QrPath) {
    try {
      $bytes = [System.IO.File]::ReadAllBytes($QrPath)
      $ms = New-Object System.IO.MemoryStream(,$bytes)
      $img = [System.Drawing.Image]::FromStream($ms)
      $old = $pic.Image
      $pic.Image = $img
      if ($old) { $old.Dispose() }
    } catch {}
  }
}
Load-Qr

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 30000
$timer.Add_Tick({ Load-Qr })
$timer.Start()

$form.Add_Shown({ $form.Activate() })
[void] $form.ShowDialog()
`;

export class PairingOverlay {
  private child: ChildProcess | null = null;
  private timer: NodeJS.Timeout | null = null;
  private qrPath: string;
  private psPath: string;

  constructor(dataDir: string) {
    const tmp = path.join(dataDir, 'tmp');
    this.qrPath = path.join(tmp, 'pair-qr.png');
    this.psPath = path.join(tmp, 'pairing-overlay.ps1');
  }

  /** Show the overlay and keep its QR fresh (regenerate every `refreshMs`). */
  async start(handlers: PairingOverlayHandlers, refreshMs: number = 60_000): Promise<void> {
    if (process.platform !== 'win32') {
      getLogger().info('Pairing overlay is Windows-only — skipped');
      return;
    }
    await this.refresh(handlers);
    this.launch(handlers.getLink());
    this.timer = setInterval(() => {
      this.refresh(handlers).catch(err => getLogger().debug({ err: err.message }, 'Pairing overlay QR refresh failed'));
    }, refreshMs);
  }

  close(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.child) {
      try { this.child.kill(); } catch { }
      this.child = null;
    }
  }

  isRunning(): boolean {
    return this.child !== null;
  }

  private async refresh(handlers: PairingOverlayHandlers): Promise<void> {
    fs.mkdirSync(path.dirname(this.qrPath), { recursive: true });
    await QRCode.toFile(this.qrPath, handlers.getPayloadJson(), {
      errorCorrectionLevel: 'M',
      width: 400,
      margin: 2,
    });
  }

  private launch(link: string): void {
    if (this.child) return;
    fs.writeFileSync(this.psPath, OVERLAY_PS, 'utf-8');
    this.child = spawn(
      'powershell',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', this.psPath, this.qrPath, link, 'Umbra OS — Pair a device'],
      { detached: true, stdio: 'ignore', windowsHide: false },
    );
    this.child.on('exit', () => { this.child = null; });
    this.child.unref();
    getLogger().info({ link }, 'Pairing overlay shown (tray-style, always-on-top)');
  }
}
