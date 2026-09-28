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
 * Ported from OpenMuse apps/server/src/auth.ts (signed HMAC URLs, 15m)
 * into Umbra OS mobile file/preview signing. Wraps AuthToken with
 * file-oriented helpers used by PreviewStreamer + workspace files.
 */

import { AuthToken } from '../api/AuthToken';

export class SignedUrl {
  constructor(private readonly auth: AuthToken) {}

  get authToken(): AuthToken {
    return this.auth;
  }

  /** Sign a preview/file path for 15 minutes. */
  sign(owner: string, filePath: string): string {
    const normalized = filePath.startsWith('/') ? filePath : `/${filePath}`;
    return this.auth.sign(owner, normalized);
  }

  /** Verify a signed preview/file URL. Returns the owner. */
  verify(url: URL): string {
    return this.auth.verifyUrl(url);
  }

  /** Verify a raw query object { owner, expires, signature } for a pathname. */
  verifyQuery(pathname: string, query: Record<string, unknown>): string {
    const url = new URL('http://localhost' + pathname);
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
    return this.auth.verifyUrl(url);
  }
}
