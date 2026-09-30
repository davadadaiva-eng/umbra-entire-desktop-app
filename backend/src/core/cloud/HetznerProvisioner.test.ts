import { HetznerProvisioner } from './HetznerProvisioner';

describe('HetznerProvisioner', () => {
  it('is disabled when no apiToken', () => {
    const p = new HetznerProvisioner({ apiToken: '', sshKeyName: '' });
    expect(p.enabled).toBe(false);
  });

  it('is enabled when apiToken + sshKeyName present', () => {
    const p = new HetznerProvisioner({ apiToken: 'test-token', sshKeyName: 'my-key' });
    expect(p.enabled).toBe(true);
  });

  it('provision returns error when disabled', async () => {
    const p = new HetznerProvisioner({ apiToken: '', sshKeyName: '' });
    const result = await p.provision('user-1', 'pro');
    expect(result.status).toBe('error');
    expect(result.error).toContain('not configured');
  });

  it('provision calls API and returns server details', async () => {
    let capturedUrl = '';
    let capturedBody: any = null;
    const mockFetch = async (url: string, init: RequestInit) => {
      capturedUrl = url;
      capturedBody = JSON.parse(init.body as string);
      return {
        ok: true,
        json: async () => ({
          server: {
            id: 12345,
            name: 'umbra-user-pro',
            public_net: { ipv4: { ip: '1.2.3.4' } },
            status: 'running',
          },
        }),
      } as Response;
    };

    const p = new HetznerProvisioner({
      apiToken: 'test-token',
      sshKeyName: 'my-key',
      location: 'nbg1',
      fetchImpl: mockFetch as any,
    });

    const result = await p.provision('user-1', 'pro');
    expect(result.serverId).toBe(12345);
    expect(result.ip).toBe('1.2.3.4');
    expect(result.status).toBe('provisioning');
    expect(result.accessUrl).toBe('http://1.2.3.4:8787');
    expect(result.sshCommand).toBe('ssh root@1.2.3.4');
    expect(result.estimatedCost).toBe('€6.70/mo');
    expect(capturedUrl).toBe('https://api.hetzner.cloud/v1/servers');
    expect(capturedBody.name).toContain('umbra');
    expect(capturedBody.server_type).toBe('cx33');
    expect(capturedBody.user_data).toContain('nodejs');
  });

  it('provision uses cx43 for advanced tier', async () => {
    const mockFetch = async (_url: string, _init: RequestInit) => {
      return {
        ok: true,
        json: async () => ({
          server: { id: 99, public_net: { ipv4: { ip: '5.6.7.8' } } },
        }),
      } as Response;
    };

    const p = new HetznerProvisioner({
      apiToken: 'tok',
      sshKeyName: 'key',
      fetchImpl: mockFetch as any,
    });

    const result = await p.provision('user-2', 'advanced');
    // advanced maps to cx43
    expect(result.estimatedCost).toBe('€10/mo');
  });

  it('provision uses cpx42 for enterprise tier', async () => {
    const mockFetch = async (_url: string, _init: RequestInit) => {
      return {
        ok: true,
        json: async () => ({
          server: { id: 7, public_net: { ipv4: { ip: '9.9.9.9' } } },
        }),
      } as Response;
    };

    const p = new HetznerProvisioner({
      apiToken: 'tok',
      sshKeyName: 'key',
      fetchImpl: mockFetch as any,
    });

    const result = await p.provision('user-3', 'enterprise');
    expect(result.estimatedCost).toBe('€29.99/mo');
  });

  it('teardown calls DELETE', async () => {
    let deletedUrl = '';
    const mockFetch = async (url: string) => {
      deletedUrl = url;
      return { ok: true, json: async () => ({}) } as Response;
    };

    const p = new HetznerProvisioner({
      apiToken: 'tok',
      sshKeyName: 'key',
      fetchImpl: mockFetch as any,
    });

    const ok = await p.teardown(12345);
    expect(ok).toBe(true);
    expect(deletedUrl).toBe('https://api.hetzner.cloud/v1/servers/12345');
  });

  it('teardown returns false when disabled', async () => {
    const p = new HetznerProvisioner({ apiToken: '', sshKeyName: '' });
    expect(await p.teardown(123)).toBe(false);
  });

  it('listUmbraServers filters by label', async () => {
    let requestedUrl = '';
    const mockFetch = async (url: string) => {
      requestedUrl = url;
      return {
        ok: true,
        json: async () => ({
          servers: [
            { id: 1, name: 'umbra-abc-pro', status: 'running', public_net: { ipv4: { ip: '1.1.1.1' } }, server_type: { name: 'cx22' }, created: '2026-01-01' },
          ],
        }),
      } as Response;
    };

    const p = new HetznerProvisioner({
      apiToken: 'tok',
      sshKeyName: 'key',
      fetchImpl: mockFetch as any,
    });

    const servers = await p.listUmbraServers();
    expect(servers).toHaveLength(1);
    expect(servers[0].name).toBe('umbra-abc-pro');
    expect(requestedUrl).toContain('label_selector=umbra=true');
  });

  it('builds cloud-init with user id and tier', async () => {
    let capturedCloudInit = '';
    const mockFetch = async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      capturedCloudInit = body.user_data || '';
      return {
        ok: true,
        json: async () => ({
          server: { id: 1, public_net: { ipv4: { ip: '1.1.1.1' } } },
        }),
      } as Response;
    };

    const p = new HetznerProvisioner({
      apiToken: 'tok',
      sshKeyName: 'key',
      fetchImpl: mockFetch as any,
    });

    await p.provision('user-test-123', 'pro');
    expect(capturedCloudInit).toContain('user-test-123');
    expect(capturedCloudInit).toContain('nodejs');
    expect(capturedCloudInit).toContain('Umbra OS');
  });
});
