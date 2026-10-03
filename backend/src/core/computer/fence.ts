/**
 * Computer fence — Option 2 (shared container + locked folders per agent).
 *
 * Pure guards with no Docker calls and no route wiring:
 *   - workspacePath(): every file/terminal path must live under
 *     /workspace/agents/{agentId}/ (no `..`, no backslashes, 2048 max)
 *   - assertAllowed(): per-agent {enabled,browser,files,shell} gates
 *   - output/file/PDF caps + secret redaction
 *
 * New isolated module — callers adopt it per call site in a later step.
 */

import { posix } from 'node:path';

export const AGENT_WORKSPACE_ROOT = '/workspace/agents';
export const WORKSPACE_PATH_MAX = 2048;
export const COMPUTER_OUTPUT_LIMIT = 128 * 1024;
export const COMPUTER_FILE_LIMIT = 256 * 1024;
export const COMPUTER_PDF_LIMIT = 10 * 1024 * 1024;

export type ComputerPermissionKind = 'browser' | 'files' | 'shell';

export interface ComputerPermissions {
  enabled: boolean;
  browser: boolean;
  files: boolean;
  shell: boolean;
}

export class ComputerFenceError extends Error {
  constructor(
    message: string,
    readonly status: 403 | 413 | 422 = 403,
  ) {
    super(message);
    this.name = 'ComputerFenceError';
    Object.setPrototypeOf(this, ComputerFenceError.prototype);
  }
}

const AGENT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export function assertAgentId(agentId: string): string {
  if (!AGENT_ID_RE.test(agentId)) {
    throw new ComputerFenceError('Unknown agent.', 403);
  }
  return agentId;
}

/**
 * Resolve a workspace path for an agent inside the shared container.
 * Accepts absolute paths under the agent's drawer, or relative paths
 * resolved against it. Anything else throws 422.
 */
export function workspacePath(agentId: string, rawPath: string): string {
  assertAgentId(agentId);
  if (rawPath.includes('\0') || rawPath.length === 0 || rawPath.length > WORKSPACE_PATH_MAX) {
    throw new ComputerFenceError('Choose a path inside your workspace.', 422);
  }
  if (rawPath.includes('\\')) {
    throw new ComputerFenceError('Use / separators, not backslashes.', 422);
  }
  const drawer = `${AGENT_WORKSPACE_ROOT}/${agentId}`;
  const joined = rawPath.startsWith('/') ? rawPath : `${drawer}/${rawPath}`;
  const normalized = posix.normalize(joined);
  if (normalized !== drawer && !normalized.startsWith(`${drawer}/`)) {
    throw new ComputerFenceError('Choose a path inside your workspace.', 422);
  }
  if (normalized.split('/').includes('..')) {
    throw new ComputerFenceError('Choose a path inside your workspace.', 422);
  }
  return normalized;
}

/** Gate a computer action behind the agent's permission switches. */
export function assertAllowed(
  perms: ComputerPermissions,
  kind: ComputerPermissionKind,
): void {
  if (!perms.enabled) {
    throw new ComputerFenceError('This computer is disabled.', 403);
  }
  if (!perms[kind]) {
    const what =
      kind === 'browser' ? 'Browser' : kind === 'files' ? 'Workspace files' : 'Terminal commands';
    throw new ComputerFenceError(
      `${what} permission is disabled for this agent.`,
      403,
    );
  }
}

/** Cap command output; returns the (possibly cut) text + truncated flag. */
export function truncateOutput(text: string): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text) <= COMPUTER_OUTPUT_LIMIT) {
    return { text, truncated: false };
  }
  // Cut on UTF-8 boundary by shrinking until it fits.
  let end = COMPUTER_OUTPUT_LIMIT;
  let cut = text.slice(0, end);
  while (Buffer.byteLength(cut) > COMPUTER_OUTPUT_LIMIT && end > 0) {
    end -= 16;
    cut = text.slice(0, end);
  }
  return { text: cut, truncated: true };
}

/** Reject oversized file writes with 413. */
export function assertFileSize(text: string): void {
  if (Buffer.byteLength(text) > COMPUTER_FILE_LIMIT) {
    throw new ComputerFenceError('Text files must be 256 KB or smaller.', 413);
  }
}

/** Reject non-PDF or oversized PDF uploads with 422. */
export function assertPdf(bytes: Uint8Array, label = 'file'): void {
  if (bytes.length > COMPUTER_PDF_LIMIT) {
    throw new ComputerFenceError(`Choose a PDF of 10 MB or smaller for ${label}.`, 422);
  }
  const magic = Buffer.from(bytes.subarray(0, 5)).toString('latin1');
  if (magic !== '%PDF-') {
    throw new ComputerFenceError(`Choose a PDF file for ${label}.`, 422);
  }
}

/** Scrub secrets from text slated for logs/receipts. */
export function redactSecrets(text: string, secrets: Array<string | undefined>): string {
  let out = text;
  for (const secret of secrets) {
    if (secret) out = out.split(secret).join('[redacted]');
  }
  return out;
}
