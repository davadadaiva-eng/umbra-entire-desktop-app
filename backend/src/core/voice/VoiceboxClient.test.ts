import { VoiceboxClient } from './VoiceboxClient';

function jsonRes(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
    arrayBuffer: async () => new ArrayBuffer(0),
  } as unknown as Response;
}

describe('VoiceboxClient', () => {
  it('detects a running server via /health', async () => {
    const client = new VoiceboxClient({ fetchFn: (async () => jsonRes({ status: 'healthy' })) as any });
    await expect(client.isRunning()).resolves.toBe(true);
  });

  it('lists profiles from /profiles', async () => {
    const client = new VoiceboxClient({
      fetchFn: (async (url: any) => {
        if (String(url).includes('/profiles')) {
          return jsonRes([{ id: 'p1', name: 'Morgan', language: 'en', voice_type: 'cloned' }]);
        }
        return jsonRes({ status: 'healthy' });
      }) as any,
    });
    const profiles = await client.listProfiles();
    expect(profiles).toHaveLength(1);
    expect(profiles[0].name).toBe('Morgan');
  });

  it('speaks via /speak and follows the SSE status stream', async () => {
    const calls: string[] = [];
    const client = new VoiceboxClient({
      fetchFn: (async (url: any, init: any) => {
        calls.push(String(url));
        if (String(url).endsWith('/speak')) {
          expect(init.method).toBe('POST');
          return jsonRes({ id: 'g1', status: 'generating' });
        }
        if (String(url).includes('/generate/g1/status')) {
          return {
            ok: true,
            status: 200,
            text: async () => 'data: {"status":"generating"}\n\ndata: {"status":"completed"}\n\n',
          } as unknown as Response;
        }
        return jsonRes({ status: 'healthy' });
      }) as any,
    });
    const result = await client.speak('hello', { profile: 'Morgan' });
    expect(result.status).toBe('completed');
    expect(calls).toContain('http://127.0.0.1:17493/speak');
  });

  it('throws when the status stream reports failure', async () => {
    const client = new VoiceboxClient({
      fetchFn: (async (url: any) => {
        if (String(url).endsWith('/speak')) return jsonRes({ id: 'g2', status: 'generating' });
        return {
          ok: true,
          status: 200,
          text: async () => 'data: {"status":"failed","error":"boom"}\n\n',
        } as unknown as Response;
      }) as any,
    });
    await expect(client.speak('hi', { profile: 'X' })).rejects.toThrow(/boom/);
  });

  it('resolves a profile name to its id', async () => {
    const client = new VoiceboxClient({
      fetchFn: (async (url: any) => {
        if (String(url).includes('/profiles')) {
          return jsonRes([{ id: 'abc', name: 'Scarlett' }]);
        }
        return jsonRes({});
      }) as any,
    });
    await expect(client.resolveProfile('scarlett')).resolves.toBe('abc');
    await expect(client.resolveProfile('nope')).resolves.toBeNull();
  });
});
