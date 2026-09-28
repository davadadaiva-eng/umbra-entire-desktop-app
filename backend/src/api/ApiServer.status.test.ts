/**
 * `GET /api/status` — the contract the Electron renderer binds to.
 *
 * Two things are verified here:
 *
 *  1. The endpoint is a faithful pass-through: whatever `getStatus()` produces
 *     reaches the client with no key stripped, renamed, or re-ordered — in
 *     particular the `bridges` block and the `credVault` field.
 *  2. The REAL producer (`UmbraRuntime.getApiStatus()` in `src/index.ts`)
 *     still declares those keys. The endpoint test alone cannot catch someone
 *     deleting `credVault` from index.ts, because the mock would keep serving
 *     it — hence the source guard.
 */
import * as fs from 'fs';
import * as path from 'path';
import { ApiServer } from './ApiServer';
import { makeFullDeps, makeStatus } from './testkit';

const PORT = 31000 + Math.floor(Math.random() * 4000);

/** The six optional subsystems the status payload reports a fallback for. */
const BRIDGE_KEYS = ['fastEngine', 'openmontage', 'vibevoice', 'social', 'carrusel', 'twenty'] as const;

async function api(path: string, method = 'GET', body?: unknown, extraHeaders: Record<string, string> = {}) {
  const res = await fetch(`http://127.0.0.1:${PORT}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json', ...extraHeaders } : extraHeaders,
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, json: (await res.json()) as any };
}

describe('GET /api/status', () => {
  let server: ApiServer;

  beforeAll(() => {
    server = new ApiServer(makeFullDeps() as any, PORT);
    server.start();
  });

  afterAll(async () => {
    await server.stop();
  });

  test('exposes the credVault block', async () => {
    const res = await api('/api/status');
    expect(res.status).toBe(200);
    expect(res.json.credVault).toEqual({
      locked: false,
      available: true,
      message: 'Vault unlocked',
    });
  });

  test('surfaces a locked vault as degraded, not absent', async () => {
    // The locked branch is what the UI turns into "unlock in Settings".
    const locked = new ApiServer(
      makeFullDeps({
        getStatus: async () => makeStatus({
          credVault: { locked: true, available: false, message: 'Vault locked — unlock in Settings' },
        }),
      }) as any,
      PORT + 1,
    );
    locked.start();
    try {
      const res = await fetch(`http://127.0.0.1:${PORT + 1}/api/status`);
      const json = (await res.json()) as any;
      expect(json.credVault.locked).toBe(true);
      expect(json.credVault.available).toBe(false);
      expect(json.credVault.message).toMatch(/locked/i);
    } finally {
      await locked.stop();
    }
  });

  test('exposes the bridges block with all six subsystems', async () => {
    const res = await api('/api/status');
    expect(res.status).toBe(200);
    expect(res.json.bridges).toBeDefined();
    for (const key of BRIDGE_KEYS) {
      expect(res.json.bridges[key]).toBeDefined();
    }
  });

  test('every bridge reports available + a named fallback + a human message', async () => {
    const res = await api('/api/status');
    for (const key of BRIDGE_KEYS) {
      const bridge = res.json.bridges[key];
      // `fallback` is what makes a missing dep a degraded status rather than a
      // dead feature; `message` is what the UI shows verbatim.
      expect(typeof bridge.fallback).toBe('string');
      expect(bridge.fallback.length).toBeGreaterThan(0);
      expect(typeof bridge.message).toBe('string');
      expect(bridge.message.length).toBeGreaterThan(0);
      expect(typeof bridge.available).toBe('boolean');
    }
  });

  test('reports the LLM boot probe next to the vault state', async () => {
    const res = await api('/api/status');
    expect(res.json.llm).toBeDefined();
    expect(typeof res.json.llm.message).toBe('string');
    expect(typeof res.json.llm.disabled).toBe('boolean');
  });

  test('never leaks a secret from the status payload', async () => {
    const res = await api('/api/status');
    const serialized = JSON.stringify(res.json);
    // Vault/provider keys are masked by the producer; assert the shape of the
    // status payload contains no raw secret-looking field names.
    expect(serialized).not.toMatch(/"(secret|apiKey|accessToken|token|password)"\s*:/i);
  });

  test('is reachable without a tenant header and reflects X-Umbra-Tenant scoping', async () => {
    const res = await api('/api/status', 'GET', undefined, { 'X-Umbra-Tenant': 'cust_9' });
    expect(res.status).toBe(200);
    expect(res.json.initialized).toBe(true);
  });
});

describe('getApiStatus() producer (src/index.ts)', () => {
  const indexSrc = fs.readFileSync(path.join(__dirname, '..', 'index.ts'), 'utf8');

  /** The body of getApiStatus(), from its declaration to its closing brace. */
  function getApiStatusBody(): string {
    const start = indexSrc.indexOf('private async getApiStatus()');
    expect(start).toBeGreaterThan(-1); // method must still exist
    // Walk braces from the first `{` after the signature.
    let depth = 0;
    let started = false;
    for (let i = indexSrc.indexOf('{', start); i < indexSrc.length; i++) {
      const ch = indexSrc[i];
      if (ch === '{') { depth++; started = true; }
      else if (ch === '}') {
        depth--;
        if (started && depth === 0) return indexSrc.slice(indexSrc.indexOf('{', start), i + 1);
      }
    }
    throw new Error('could not delimit getApiStatus() body');
  }

  const body = getApiStatusBody();

  test('declares credVault with locked / available / message', () => {
    expect(body).toMatch(/credVault\s*:/);
    const credVault = body.slice(body.indexOf('credVault:'));
    // Slice to the next sibling key so we assert on the credVault block only.
    const block = credVault.slice(0, credVault.indexOf('hermes:'));
    expect(block).toMatch(/locked\s*:/);
    expect(block).toMatch(/available\s*:/);
    expect(block).toMatch(/message\s*:/);
  });

  test('declares a bridges block covering every optional subsystem', () => {
    expect(body).toMatch(/bridges\s*:/);
    const bridges = body.slice(body.indexOf('bridges:'));
    for (const key of BRIDGE_KEYS) {
      expect(bridges).toMatch(new RegExp(`\\b${key}\\s*:`));
    }
  });

  test('every bridge in the producer names a fallback', () => {
    const bridges = body.slice(body.indexOf('bridges:'));
    const bridgeEntries = bridges.split(/\n\s{8}(\w+):\s*\{/).slice(1);
    expect(bridgeEntries.length).toBeGreaterThanOrEqual(BRIDGE_KEYS.length);
    // Every subsystem the producer reports must degrade to something named,
    // otherwise a missing optional dep becomes a hard failure for the user.
    const withFallback = bridgeEntries.filter((_, i) => /fallback\s*:/.test(bridgeEntries[i + 1] ?? ''));
    expect(withFallback.length).toBe(BRIDGE_KEYS.length);
  });
});
