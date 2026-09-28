/**
 * Error + auth contract for the ApiServer.
 *
 * These are the behaviours the endpoint-level suites in the other files cannot
 * reach, because they need a *failing* dependency or a request that never
 * becomes a valid route body:
 *
 *  - an `AppError` thrown by a route keeps its own status (this is what makes
 *    `validate.ts`'s 400/422 helpers work at all — they were being flattened to
 *    500);
 *  - an optional dependency missing on this node answers 501, not 500;
 *  - a configured-but-off feature answers 503;
 *  - malformed / oversized / non-object bodies answer 400 / 413 / 400 and the
 *    client actually receives the response (the old code destroyed the socket
 *    before writing it);
 *  - every auth-namespace route accepts `Authorization: Bearer`, and the
 *    desktop client's `{ key }` body alias.
 */
import { ApiServer } from './ApiServer';
import { AppError, codeForStatus } from './AppError';
import { resolveApiKey } from './apiKey';
import { parseOr422, requireString, validateBody, commonSchemas } from './validate';
import { z } from 'zod';
import { makeFullDeps, makeMinimalDeps } from './testkit';

const PORT = 35000 + Math.floor(Math.random() * 4000);

/** Bind a request helper to one server instance (several suites run their own). */
const apiOn = (port: number) => async (
  path: string,
  method = 'GET',
  body?: unknown,
  extraHeaders: Record<string, string> = {},
) => {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json', ...extraHeaders } : extraHeaders,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, json: (await res.json()) as any, headers: res.headers };
};

const api = apiOn(PORT);

describe('ApiServer error mapping', () => {
  let server: ApiServer;

  beforeAll(() => {
    server = new ApiServer(makeFullDeps() as any, PORT);
    server.start();
  });

  afterAll(async () => {
    await server.stop();
  });

  test('honours an AppError status thrown by a dependency', async () => {
    const s = new ApiServer(
      makeFullDeps({ getReposs: undefined, getModelStatus: () => { throw new AppError('model registry offline', 503); } } as any) as any,
      PORT + 1,
    );
    s.start();
    try {
      const res = await fetch(`http://127.0.0.1:${PORT + 1}/api/llm/models`);
      const json = (await res.json()) as any;
      expect(res.status).toBe(503);
      expect(json.error).toBe('model registry offline');
      expect(json.code).toBe(codeForStatus(503));
      expect(json.code).toBe('SERVICE_UNAVAILABLE');
    } finally {
      await s.stop();
    }
  });

  test('carries a machine-readable code alongside every error message', async () => {
    const res = await api('/api/task', 'POST', {});
    expect(res.status).toBe(500);
    expect(res.json.error).toBe('description is required');
    expect(res.json.code).toBe('INTERNAL_ERROR');
  });

  test('a 404 route is reported before any handler runs', async () => {
    const res = await api('/api/nope');
    expect(res.status).toBe(404);
    expect(res.json.error).toContain('No route');
  });

  test('a method mismatch is a 404, not a 500', async () => {
    // DELETE /api/status has no route; it must not fall through to GET's handler.
    const res = await api('/api/status', 'DELETE');
    expect(res.status).toBe(404);
  });

  test('a null capture is 404, not an internal error', async () => {
    const s = new ApiServer(makeFullDeps({ captureGhost: async () => null }) as any, PORT + 2);
    s.start();
    try {
      const res = await fetch(`http://127.0.0.1:${PORT + 2}/api/ghost/capture`);
      const json = (await res.json()) as any;
      expect(res.status).toBe(404);
      expect(json.code).toBe('NOT_FOUND');
      expect(json.error).toMatch(/no capture available/i);
    } finally {
      await s.stop();
    }
  });

  test('a configured-but-off feature answers 503 SERVICE_DISABLED', async () => {
    const s = new ApiServer(
      makeFullDeps({ telcoSendSms: () => { throw new Error('Telnyx is not configured'); } } as any) as any,
      PORT + 3,
    );
    s.start();
    try {
      const res = await fetch(`http://127.0.0.1:${PORT + 3}/api/telco/sms`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to: '+1555', text: 'hi' }),
      });
      const json = (await res.json()) as any;
      expect(res.status).toBe(503);
      expect(json.code).toBe('SERVICE_DISABLED');
    } finally {
      await s.stop();
    }
  });
});

describe('ApiServer body parsing', () => {
  let server: ApiServer;

  beforeAll(() => {
    server = new ApiServer(makeFullDeps() as any, PORT + 10);
    server.start();
  });

  afterAll(async () => {
    await server.stop();
  });

  const post = (body: string, path = '/api/task') =>
    fetch(`http://127.0.0.1:${PORT + 10}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });

  test('malformed JSON answers 400 with a structured body', async () => {
    const res = await post('{not json');
    expect(res.status).toBe(400);
    const json = (await res.json()) as any;
    expect(json.error).toBe('Invalid JSON body');
    expect(json.code).toBe('BAD_REQUEST');
  });

  test('a JSON array body answers 400 (routes read named fields off an object)', async () => {
    const res = await post('[1,2,3]');
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).code).toBe('BAD_REQUEST');
  });

  test('a JSON scalar body answers 400', async () => {
    const res = await post('"just a string"');
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).code).toBe('BAD_REQUEST');
  });

  test('an empty body is treated as {} rather than a parse error', async () => {
    // POST /api/llm/test takes no body at all; that must not be a 400.
    const res = await fetch(`http://127.0.0.1:${PORT + 10}/api/llm/test`, { method: 'POST' });
    expect(res.status).toBe(200);
  });

  test('an oversized body answers 413 and the client receives it', async () => {
    // 6MB > the 5MB cap. The old code destroyed the request socket before
    // writing a response, so the client saw a connection reset instead.
    const huge = JSON.stringify({ description: 'x'.repeat(6 * 1024 * 1024) });
    const res = await post(huge);
    expect(res.status).toBe(413);
    const json = (await res.json()) as any;
    expect(json.code).toBe('PAYLOAD_TOO_LARGE');
    expect(json.error).toMatch(/too large/i);
  });

  test('a body just under the cap is still accepted', async () => {
    const res = await post(JSON.stringify({ description: 'x'.repeat(1024) }));
    expect(res.status).toBe(200);
    expect((await res.json()) as any).toHaveProperty('taskId');
  });
});

describe('ApiServer optional dependencies (501, not 500)', () => {
  let server: ApiServer;
  const call = apiOn(PORT + 20);

  beforeAll(() => {
    server = new ApiServer(makeMinimalDeps() as any, PORT + 20);
    server.start();
  });

  afterAll(async () => {
    await server.stop();
  });

  const cases: Array<[string, string, unknown]> = [
    ['POST', '/api/task/t-1/cancel', undefined],
    ['POST', '/api/task/t-1/retry', {}],
    ['POST', '/api/worker/claim', { taskId: 't', workerId: 'w' }],
    ['POST', '/api/worker/heartbeat', { taskId: 't', workerId: 'w' }],
    ['POST', '/api/worker/release', { taskId: 't', workerId: 'w' }],
    ['POST', '/api/worker/recover', { workerId: 'w' }],
    ['POST', '/api/actions/propose', { taskId: 't', action: 'a' }],
    ['POST', '/api/actions/review', { proposalId: 'p', hash: 'h' }],
    ['GET', '/api/actions/proposal/p-1', undefined],
    ['GET', '/api/task/t-1/proposals', undefined],
    ['POST', '/api/task/t-1/input', { question: 'q' }],
    ['POST', '/api/input/in-1/answer', { answer: 'a', taskId: 't' }],
  ];

  test.each(cases)('%s %s answers 501 NOT_IMPLEMENTED', async (method, path, body) => {
    const res = await call(path, method, body);
    expect(res.status).toBe(501);
    expect(res.json.code).toBe('NOT_IMPLEMENTED');
    expect(res.json.error).toMatch(/not available on this node/i);
  });

  test('GET /api/task/:id/activity degrades to an empty feed instead of failing', async () => {
    const res = await call('/api/task/t-1/activity');
    expect(res.status).toBe(200);
    expect(res.json.activity).toEqual([]);
  });
});

describe('auth-namespace key resolution', () => {
  let server: ApiServer;
  const call = apiOn(PORT + 30);

  beforeAll(() => {
    server = new ApiServer(makeFullDeps() as any, PORT + 30);
    server.start();
  });

  afterAll(async () => {
    await server.stop();
  });

  const bearer = { Authorization: 'Bearer sk-valid' };

  test('accepts Authorization: Bearer on every auth route', async () => {
    const cases: Array<[string, string, unknown, string]> = [
      ['POST', '/api/auth/login-key', {}, 'user'],
      ['GET', '/api/auth/me', undefined, 'user'],
      ['GET', '/api/auth/devices', undefined, 'devices'],
      ['POST', '/api/auth/devices/pair', { name: 'Laptop', type: 'desktop' }, 'device'],
      ['GET', '/api/auth/plan', undefined, 'plan'],
      ['GET', '/api/plan', undefined, 'plan'],
    ];
    for (const [method, path, body, field] of cases) {
      const res = await call(path, method, body, bearer);
      expect(res.status).toBe(200);
      expect(res.json[field]).toBeDefined();
    }
  });

  test('accepts Authorization: Bearer on DELETE /api/auth/devices/:id', async () => {
    const res = await call('/api/auth/devices/d-1', 'DELETE', undefined, bearer);
    expect(res.status).toBe(200);
    expect(res.json.removed.apiKey).toBe('sk-valid');
  });

  test('accepts the ?key= compat query param', async () => {
    const res = await call('/api/auth/me?key=sk-valid');
    expect(res.status).toBe(200);
    expect(res.json.user.email).toBe('a@b.c');
  });

  test.each(['apiKey', 'api_key', 'key'])('accepts body.%s on POST /api/auth/login-key', async (field) => {
    const res = await call('/api/auth/login-key', 'POST', { [field]: 'sk-valid' });
    expect(res.status).toBe(200);
    expect(res.json.user.id).toBe('u1');
  });

  test('accepts the { key } body the desktop client actually sends', async () => {
    // desktop/src/lib/backend.ts authLoginKey posts JSON.stringify({ key: apiKey }).
    const res = await call('/api/auth/login-key', 'POST', { key: 'sk-valid' });
    expect(res.status).toBe(200);
    expect(res.json.user.id).toBe('u1');
  });

  test('accepts the { key } body on device pairing', async () => {
    // desktop/src/lib/backend.ts authPairDevice posts { key, name, type }.
    const res = await call('/api/auth/devices/pair', 'POST', { key: 'sk-valid', name: 'Phone', type: 'mobile' });
    expect(res.status).toBe(200);
    expect(res.json.device.apiKey).toBe('sk-valid');
    expect(res.json.device.type).toBe('mobile');
  });

  test('the header wins over a conflicting body key', async () => {
    const res = await call('/api/auth/login-key', 'POST', { key: 'sk-wrong' }, bearer);
    expect(res.status).toBe(200);
    expect(res.json.user.id).toBe('u1');
  });

  test('a missing key is rejected on every auth route', async () => {
    const paths = [
      ['POST', '/api/auth/login-key', {}],
      ['GET', '/api/auth/me', undefined],
      ['GET', '/api/auth/devices', undefined],
      ['GET', '/api/auth/plan', undefined],
    ] as Array<[string, string, unknown]>;
    for (const [method, path, body] of paths) {
      const res = await call(path, method, body);
      expect(res.status).toBe(500);
      expect(res.json.error).toMatch(/api ?key (is )?required/i);
    }
  });

  test('an invalid key surfaces the dependency error, not a crash', async () => {
    const res = await call('/api/auth/me?key=sk-bad');
    expect(res.status).toBe(500);
    expect(res.json.error).toBe('Invalid API key');
  });
});

describe('resolveApiKey() unit contract', () => {
  const url = (q = '') => new URL(`http://127.0.0.1/api/auth/me${q}`);

  it('prefers the Authorization header', () => {
    const req = { method: 'GET', headers: { authorization: 'Bearer hdr-key' } } as any;
    expect(resolveApiKey(req, url('?key=q-key'), { key: 'b-key' }).key).toBe('hdr-key');
  });

  it('falls back to the query param, flagged as deprecated', () => {
    const req = { method: 'GET', headers: {} } as any;
    const r = resolveApiKey(req, url('?key=q-key'), { key: 'b-key' });
    expect(r.key).toBe('q-key');
    expect(r.via).toBe('query');
    expect(r.usedDeprecatedQuery).toBe(true);
  });

  it('falls back to the body aliases in order apiKey, api_key, key, token', () => {
    const req = { method: 'POST', headers: {} } as any;
    expect(resolveApiKey(req, url(), { apiKey: 'a', api_key: 'b', key: 'c', token: 'd' }).key).toBe('a');
    expect(resolveApiKey(req, url(), { api_key: 'b', key: 'c', token: 'd' }).key).toBe('b');
    expect(resolveApiKey(req, url(), { key: 'c', token: 'd' }).key).toBe('c');
    expect(resolveApiKey(req, url(), { token: 'd' }).key).toBe('d');
  });

  it('reports via=none and an empty key when nothing is supplied', () => {
    const r = resolveApiKey({ method: 'GET', headers: {} } as any, url(), {});
    expect(r).toEqual({ key: '', via: 'none', usedDeprecatedQuery: false });
  });

  it('ignores a non-Bearer Authorization header', () => {
    const req = { method: 'GET', headers: { authorization: 'Basic dXNlcjpwYXNz' } } as any;
    expect(resolveApiKey(req, url(), {}).key).toBe('');
  });

  it('tolerates a missing request object', () => {
    expect(resolveApiKey(undefined, url('?key=q'), {}).key).toBe('q');
  });
});

describe('validate.ts helpers reach the wire with their real status', () => {
  let server: ApiServer;
  const call = apiOn(PORT + 40);

  beforeAll(() => {
    // Wire a throwaway route surface: the helpers are what the route map would
    // use, so assert what a client actually receives.
    server = new ApiServer(
      makeFullDeps({
        rememberMemory: () => parseOr422(commonSchemas.taskCreate, {}),
        searchKnowledge: () => { requireString({}, 'text'); return []; },
        getMacros: () => validateBody(z.object({ mode: z.enum(['fast', 'slow']) }), { mode: 'sideways' }),
      } as any) as any,
      PORT + 40,
    );
    server.start();
  });

  afterAll(async () => {
    await server.stop();
  });

  test('a zod failure surfaces as 422 UNPROCESSABLE_ENTITY', async () => {
    const res = await call('/api/memory/remember', 'POST', { text: 'ok' });
    expect(res.status).toBe(422);
    expect(res.json.code).toBe('UNPROCESSABLE_ENTITY');
    // The message must NAME the offending field — a bare zod "Required" leaves
    // the caller guessing which key to fix.
    expect(res.json.error).toMatch(/^description: /);
  });

  test('requireString surfaces as 400 BAD_REQUEST', async () => {
    const res = await call('/api/knowledge/search');
    expect(res.status).toBe(400);
    expect(res.json.code).toBe('BAD_REQUEST');
  });

  test('an invalid enum value surfaces as 422 with the joined issues', async () => {
    const res = await call('/api/macros');
    expect(res.status).toBe(422);
    expect(res.json.error).toMatch(/mode/);
  });
});

describe('CORS', () => {
  let server: ApiServer;

  beforeAll(() => {
    server = new ApiServer(makeFullDeps() as any, PORT + 50);
    server.start();
  });

  afterAll(async () => {
    await server.stop();
  });

  test('answers a preflight with 204 and the expected methods/headers', async () => {
    const res = await fetch(`http://127.0.0.1:${PORT + 50}/api/task`, {
      method: 'OPTIONS',
      headers: { Origin: 'http://localhost:5173', 'Access-Control-Request-Method': 'POST' },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-methods')).toContain('POST');
    expect(res.headers.get('access-control-allow-headers')).toContain('X-Umbra-Tenant');
  });

  test('echoes an allowlisted origin', async () => {
    const res = await fetch(`http://127.0.0.1:${PORT + 50}/api/health`, {
      headers: { Origin: 'http://127.0.0.1:5173' },
    });
    expect(res.headers.get('access-control-allow-origin')).toBe('http://127.0.0.1:5173');
  });

  test('does not reflect a non-allowlisted origin', async () => {
    const res = await fetch(`http://127.0.0.1:${PORT + 50}/api/health`, {
      headers: { Origin: 'https://evil.example.com' },
    });
    // No ACAO ⇒ the browser blocks the read. Never '*'.
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });
});

describe('bind host', () => {
  const original = { bind: process.env['UMBRA_BIND_HOST'], host: process.env['UMBRA_HOST'] };

  afterEach(() => {
    if (original.bind === undefined) delete process.env['UMBRA_BIND_HOST'];
    else process.env['UMBRA_BIND_HOST'] = original.bind;
    if (original.host === undefined) delete process.env['UMBRA_HOST'];
    else process.env['UMBRA_HOST'] = original.host;
  });

  /** `net.Server.address()` is synchronous — poll until the bind lands. */
  const addr = async (s: ApiServer) => {
    const server = (s as any).server as { address(): { address: string; port: number } | string | null };
    for (let i = 0; i < 200; i++) {
      const a = server.address();
      if (a && typeof a === 'object') return a;
      await new Promise(r => setTimeout(r, 5));
    }
    throw new Error('server never reported a bound address');
  };

  test('defaults to loopback only', async () => {
    delete process.env['UMBRA_BIND_HOST'];
    delete process.env['UMBRA_HOST'];
    const s = new ApiServer(makeFullDeps() as any, 0);
    s.start();
    try {
      expect((await addr(s)).address).toBe('127.0.0.1');
    } finally {
      await s.stop();
    }
  });

  test('a blank UMBRA_BIND_HOST does not widen the bind to 0.0.0.0', async () => {
    // Regression: an empty env var used to win the `||` chain and make Node
    // listen on every interface, exposing the control plane to the LAN.
    process.env['UMBRA_BIND_HOST'] = '   ';
    delete process.env['UMBRA_HOST'];
    const s = new ApiServer(makeFullDeps() as any, 0);
    s.start();
    try {
      expect((await addr(s)).address).toBe('127.0.0.1');
    } finally {
      await s.stop();
    }
  });

  test('honours an explicit loopback alias', async () => {
    delete process.env['UMBRA_BIND_HOST'];
    delete process.env['UMBRA_HOST'];
    const s = new ApiServer(makeFullDeps() as any, 0, 'localhost');
    s.start();
    try {
      const { address } = await addr(s);
      expect(['127.0.0.1', '::1']).toContain(address);
    } finally {
      await s.stop();
    }
  });
});
