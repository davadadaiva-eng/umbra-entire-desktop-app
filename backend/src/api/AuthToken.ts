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
 * Ported from OpenMuse apps/server/src/auth.ts (Bearer sessions + signed
 * HMAC URLs with 15-minute expiry) into Umbra OS backend.
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import * as path from 'node:path';

const digest = (value: string): Buffer => createHash('sha256').update(value).digest();

interface SessionRecord {
  owner: string;
  expiresAt: number;
}

export class AuthError extends Error {
  readonly status: number;
  constructor(message: string, status = 401) {
    super(message);
    this.name = 'AuthError';
    this.status = status;
  }
}

export class AuthToken {
  private sessions = new Map<string, SessionRecord>();

  constructor(
    private readonly signingKey: string,
    private readonly publicBaseUrl: string = '',
  ) {}

  /** Issue a 24h Bearer session token for an owner (e.g. user id / device id). */
  async createSession(owner: string): Promise<{ token: string; owner: string }> {
    const token = randomBytes(32).toString('base64url');
    this.sessions.set(digest(token).toString('hex'), {
      owner,
      expiresAt: Date.now() + 24 * 60 * 60 * 1000,
    });
    return { token, owner };
  }

  /** Verify an `Authorization: Bearer <token>` header value. Returns the owner. */
  async verifyBearer(authorization?: string): Promise<string> {
    if (!authorization?.startsWith('Bearer ')) throw new AuthError('Sign in to Umbra', 401);
    const id = digest(authorization.slice(7)).toString('hex');
    const session = this.sessions.get(id);
    if (!session || session.expiresAt < Date.now()) throw new AuthError('Session expired. Sign in again.', 401);
    return session.owner;
  }

  /** Sign a path into a 15-minute HMAC URL (for preview/files). */
  sign(owner: string, urlPath: string): string {
    const expires = String(Date.now() + 15 * 60 * 1000);
    const signature = createHmac('sha256', this.signingKey)
      .update(`${owner}\n${urlPath}\n${expires}`)
      .digest('hex');
    const base = this.publicBaseUrl.replace(/\/$/, '');
    return `${base}${urlPath}?owner=${encodeURIComponent(owner)}&expires=${expires}&signature=${signature}`;
  }

  /** Verify a signed URL (pathname + owner/expires/signature query). Returns owner. */
  verifyUrl(url: URL): string {
    const owner = url.searchParams.get('owner') ?? '';
    const expires = url.searchParams.get('expires') ?? '';
    const signature = url.searchParams.get('signature') ?? '';
    if (!owner || !/^\d+$/.test(expires) || Number(expires) < Date.now() || !/^\w{64}$/.test(signature)) {
      throw new AuthError('Document link expired; refresh and try again', 401);
    }
    const expected = createHmac('sha256', this.signingKey)
      .update(`${owner}\n${url.pathname}\n${expires}`)
      .digest('hex');
    if (!timingSafeEqual(Buffer.from(expected), Buffer.from(signature))) {
      throw new AuthError('Invalid access link', 403);
    }
    return owner;
  }

  revokeAll(owner: string): void {
    for (const [id, session] of this.sessions) {
      if (session.owner === owner) this.sessions.delete(id);
    }
  }
}

export function loadOrCreateSigningKey(dataDir: string): string {
  mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, 'session-signing-key');
  try {
    if (existsSync(file)) return readFileSync(file, 'utf8').trim();
  } catch {
    // fall through to creation
  }
  const key = randomBytes(32).toString('base64');
  try {
    writeFileSync(file, key, { mode: 0o600, flag: 'wx' });
  } catch {
    // Another process created it first.
    try {
      return readFileSync(file, 'utf8').trim();
    } catch {
      return key;
    }
  }
  return key;
}

export function createAuthToken(dataDir: string, publicBaseUrl = ''): AuthToken {
  return new AuthToken(loadOrCreateSigningKey(dataDir), publicBaseUrl);
}
