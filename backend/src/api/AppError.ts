/**
 * MIT License
 *
 * Copyright (c) 2026 OpenMuse contributors
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 *
 * ---------------------------------------------------------------------------
 * Umbra OS — ApiError port.
 * Modeled on openmuse `apps/server/src/errors.ts` (MIT, OpenMuse contributors).
 * Provides a typed HTTP-status-carrying error for the Umbra ApiServer so route
 * handlers can return precise statuses (400/404/422/...) instead of generic 500s.
 * Backwards compatible: existing handlers that throw plain Error still map to
 * 500/503 via ApiServer.handleRequest.
 * ---------------------------------------------------------------------------
 */

/** HTTP statuses an API handler is allowed to return via AppError. */
export type AppErrorStatus =
  | 400
  | 401
  | 403
  | 404
  | 409
  | 413
  | 422
  | 429
  | 500
  | 501
  | 502
  | 503;

export class AppError extends Error {
  constructor(
    message: string,
    public readonly status: AppErrorStatus = 400,
  ) {
    super(message);
    this.name = 'AppError';
    // Maintain proper prototype chain when targeting ES2022 with TS.
    Object.setPrototypeOf(this, AppError.prototype);
  }
}

/** Type-guard for AppError. */
export function isAppError(err: unknown): err is AppError {
  return err instanceof AppError;
}

/**
 * Map an AppError status to a stable machine-readable code for clients.
 * Mirrors the openmuse pattern of `{ error: message }` plus a code.
 */
export function codeForStatus(status: AppErrorStatus): string {
  switch (status) {
    case 400:
      return 'BAD_REQUEST';
    case 401:
      return 'UNAUTHORIZED';
    case 403:
      return 'FORBIDDEN';
    case 404:
      return 'NOT_FOUND';
    case 409:
      return 'CONFLICT';
    case 413:
      return 'PAYLOAD_TOO_LARGE';
    case 422:
      return 'UNPROCESSABLE_ENTITY';
    case 429:
      return 'RATE_LIMITED';
    case 502:
      return 'BAD_GATEWAY';
    case 503:
      return 'SERVICE_UNAVAILABLE';
    case 501:
      return 'NOT_IMPLEMENTED';
    case 500:
    default:
      return 'INTERNAL_ERROR';
  }
}
