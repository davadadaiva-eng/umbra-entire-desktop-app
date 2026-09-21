/**
 * HardwareId — a stable, machine-unique fingerprint for vault key binding.
 *
 * Windows: queries the CPU identifier and the motherboard serial number via
 * WMI (Win32_Processor.ProcessorId + Win32_BaseBoard.SerialNumber) and hashes
 * them together — so the same binary copied to another machine derives a
 * different key and cannot decrypt the vault.
 *
 * Non-Windows (e.g. the Linux cloud node): falls back to a fingerprint of
 * hostname + network MACs, which is still machine-unique. It deliberately
 * NEVER returns a constant like "local-machine" — a constant HWID would make
 * the "machine binding" meaningless.
 *
 * The result is cached after the first query (PowerShell is slow).
 */

import * as crypto from 'crypto';
import * as os from 'os';
import { execSync } from 'child_process';

let cached: string | undefined;

/** SHA-256 of the raw CPU + motherboard identifiers (hex). */
function windowsHwid(): string | null {
  try {
    const ps =
      "$ProgressPreference='SilentlyContinue'; " +
      "Get-CimInstance Win32_Processor | Select-Object -ExpandProperty ProcessorId; " +
      "Get-CimInstance Win32_BaseBoard | Select-Object -ExpandProperty SerialNumber";
    const encoded = Buffer.from(ps, 'utf16le').toString('base64');
    const out = execSync(`powershell -NoProfile -NonInteractive -EncodedCommand ${encoded}`, {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 15_000,
    }).trim();
    const parts = out.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    if (parts.length === 0) return null;
    return crypto.createHash('sha256').update(parts.join('|')).digest('hex');
  } catch {
    return null;
  }
}

/** Cross-platform fallback: hostname + MACs (stable per machine, never constant). */
function fallbackHwid(): string {
  const macs = Object.values(os.networkInterfaces())
    .flatMap(list => list ?? [])
    .filter(i => i && !i.internal && i.mac && i.mac !== '00:00:00:00:00:00')
    .map(i => i.mac)
    .sort();
  return crypto
    .createHash('sha256')
    .update(`${os.hostname()}|${macs.join(',')}`)
    .digest('hex');
}

/**
 * The machine fingerprint used to bind the vault. Overridable via
 * UMBRA_HWID (e.g. a fleet operator pinning a stable value) — otherwise a
 * real machine-derived value, never a constant.
 */
export function getStableHwid(envHwid?: string): string {
  if (envHwid) return envHwid;
  if (cached) return cached;
  cached = (os.platform() === 'win32' ? windowsHwid() : null) ?? fallbackHwid();
  return cached;
}

/** Force-recompute (mostly for tests). */
export function resetHwidCache(): void {
  cached = undefined;
}
