/**
 * MIT License
 * Copyright (c) 2026 OpenMuse contributors
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * Ported from OpenMuse apps/worker/src/network.ts into Umbra OS backend.
 *
 * validatePublicUrl + isPublicIp: only public HTTP(S) on ports 80/443,
 * DNS resolves entirely to global-unicast addresses (SSRF guard).
 */

import type { LookupAddress } from 'node:dns';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export class UrlGuardError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status = 403) {
    super(message);
    this.name = 'UrlGuardError';
    this.code = code;
    this.status = status;
  }
}

// Conservative global-unicast allowlist: transition, documentation, private,
// loopback, multicast and reserved networks are never browser destinations.
export function isPublicIp(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const [a = 0, b = 0, c = 0] = address.split('.').map(Number);
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113)
    );
  }
  if (family !== 6 || address.includes('.') || address.includes('%')) return false;
  const halves = address.toLowerCase().split('::');
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves[1] ? halves[1].split(':') : [];
  const words =
    halves.length === 1
      ? left
      : [...left, ...Array(8 - left.length - right.length).fill('0'), ...right];
  const first = Number.parseInt(words[0] ?? '0', 16);
  const second = Number.parseInt(words[1] ?? '0', 16);
  return (
    first >= 0x2000 &&
    first <= 0x3fff &&
    !(first === 0x2001 && (second < 0x200 || second === 0xdb8)) &&
    first !== 0x2002 &&
    !(first === 0x3fff && second < 0x1000)
  );
}

export type UrlResolver = (hostname: string) => Promise<LookupAddress[]>;

export async function validatePublicUrl(
  value: string,
  resolve: UrlResolver = (hostname) => lookup(hostname, { all: true, verbatim: true }),
): Promise<{ url: URL; address: string; family: number }> {
  const blocked = () =>
    new UrlGuardError(
      'BLOCKED_URL',
      'Only public HTTP(S) destinations on ports 80 and 443 are allowed.',
      403,
    );
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw blocked();
  }
  const hostname = url.hostname
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '')
    .toLowerCase();
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    (url.port && url.port !== '80' && url.port !== '443') ||
    !hostname ||
    /(^|\.)(localhost|local|internal|home|lan)$/.test(hostname)
  )
    throw blocked();
  let addresses: LookupAddress[];
  if (isIP(hostname)) addresses = [{ address: hostname, family: isIP(hostname) }];
  else {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      addresses = await Promise.race([
        resolve(hostname),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('DNS timeout')), 5000);
        }),
      ]);
    } catch {
      throw new UrlGuardError('DNS_UNAVAILABLE', 'The destination could not be resolved.', 502);
    } finally {
      clearTimeout(timer);
    }
  }
  if (addresses.length === 0 || addresses.some((entry) => !isPublicIp(entry.address)))
    throw blocked();
  const selected = addresses.find((entry) => entry.family === 4) ?? addresses[0];
  if (!selected) throw blocked();
  return { url, address: selected.address, family: selected.family };
}

/** Allow-list for non-network pages (about:blank); everything else is guarded. */
export async function ensurePublicUrl(value: string): Promise<URL | null> {
  const trimmed = (value || '').trim();
  if (!trimmed || trimmed === 'about:blank') return null;
  const { url } = await validatePublicUrl(trimmed);
  return url;
}
