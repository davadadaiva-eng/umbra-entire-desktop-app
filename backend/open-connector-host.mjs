#!/usr/bin/env node
/**
 * open-connector-host.mjs — zero-Docker host for the 1,500-provider gateway.
 *
 * Runs the published `@oomol-lab/open-connector` runtime as-is (no provider
 * source copied — same API-client posture as the Docker image, see
 * backend/THIRD-PARTY-NOTICES.md) and serves its /v1 + /mcp + /api contract
 * on loopback. Umbra's OpenConnectorBridge talks to it at
 * OPENCONNECTOR_BASE_URL (default http://127.0.0.1:3000).
 *
 *   npm run connectors:host
 *
 * Env:
 *   OPENCONNECTOR_PORT            default 3000
 *   OPENCONNECTOR_PUBLIC_ORIGIN   default http://127.0.0.1:<port> (needed for
 *                                 provider OAuth callback URLs)
 *   OOMOL_CONNECT_DATA_DIR        default ~/.umbra/open-connector (SQLite +
 *                                 transit files; stays out of the repo)
 *   OOMOL_CONNECT_ENCRYPTION_KEY  AES-256-GCM for stored credentials.
 *                                 Optional on loopback; set it anyway.
 *   OOMOL_CONNECT_ADMIN_TOKEN     Bearer for /api/* management calls.
 *                                 Optional on loopback; REQUIRED when exposed.
 *   OPENCONNECTOR_RUNTIME_TOKEN   Bearer for /v1 + /mcp. Optional locally.
 */
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { serve } from '@hono/node-server';
import { createConnectorRuntime } from '@oomol-lab/open-connector';

const port = Number(process.env.OPENCONNECTOR_PORT || 3000);
const dataDir = process.env.OOMOL_CONNECT_DATA_DIR
  || path.join(os.homedir(), '.umbra', 'open-connector');
fs.mkdirSync(dataDir, { recursive: true });

const connector = await createConnectorRuntime({
  dataDir,
  publicOrigin: process.env.OPENCONNECTOR_PUBLIC_ORIGIN || `http://127.0.0.1:${port}`,
  publicOriginConfigured: Boolean(process.env.OPENCONNECTOR_PUBLIC_ORIGIN),
  encryptionKey: process.env.OOMOL_CONNECT_ENCRYPTION_KEY || undefined,
  adminToken: process.env.OOMOL_CONNECT_ADMIN_TOKEN || undefined,
  runtimeToken: process.env.OPENCONNECTOR_RUNTIME_TOKEN || undefined,
});

const server = serve({ fetch: (request) => connector.fetch(request), port });
// eslint-disable-next-line no-console
console.log(`[open-connector] gateway listening on http://127.0.0.1:${port} (data: ${dataDir})`);

const shutdown = async () => {
  // eslint-disable-next-line no-console
  console.log('[open-connector] shutting down…');
  server.close();
  await connector.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
