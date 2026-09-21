import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { HermesAgentBridge } from './HermesAgent';

describe('HermesAgentBridge', () => {
  let fakeBin: string;

  beforeAll(() => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'umbra-hermes-'));
    fakeBin = path.join(dir, 'fake-hermes.cmd');
    fs.writeFileSync(
      fakeBin,
      `@echo off\r\nif "%1"=="-z" (\r\n  echo FAKE_HERMES_OUTPUT: %2\r\n  exit /b 0\r\n)\r\nexit /b 1\r\n`,
      'utf-8',
    );
  });

  it('reports not installed when no binary is present', () => {
    const bridge = new HermesAgentBridge({ bin: 'definitely-not-a-real-hermes-bin' });
    expect(bridge.isInstalled()).toBe(false);
  });

  it('runs a headless one-shot task through the configured binary', async () => {
    const bridge = new HermesAgentBridge({ bin: fakeBin, timeoutMs: 30_000 });
    expect(bridge.isInstalled()).toBe(true);
    const res = await bridge.runTask('do the thing');
    expect(res.ok).toBe(true);
    expect(res.output).toContain('FAKE_HERMES_OUTPUT');
    expect(res.exitCode).toBe(0);
  });

  it('surfaces a nonzero exit as failure', async () => {
    const failing = path.join(path.dirname(fakeBin), 'fail-hermes.cmd');
    fs.writeFileSync(failing, '@echo off\r\necho boom >&2\r\nexit /b 3\r\n', 'utf-8');
    const bridge = new HermesAgentBridge({ bin: failing, timeoutMs: 30_000 });
    const res = await bridge.runTask('x');
    expect(res.ok).toBe(false);
    expect(res.exitCode).toBe(3);
    expect(res.error).toBeDefined();
  });

  it('times out slow tasks', async () => {
    const slow = path.join(path.dirname(fakeBin), 'slow-hermes.cmd');
    fs.writeFileSync(slow, '@echo off\r\nping -n 6 127.0.0.1 >nul\r\nexit /b 0\r\n', 'utf-8');
    const bridge = new HermesAgentBridge({ bin: slow, timeoutMs: 10 });
    const res = await bridge.runTask('slow');
    expect(res.timedOut).toBe(true);
    expect(res.ok).toBe(false);
  });

  it('registers the MCP bridge by writing the umbra server into the agent config', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'umbra-hermes-home-'));
    const bridge = new HermesAgentBridge({ bin: fakeBin, hermesHome: home });
    const ok = await bridge.registerMcpBridge('http://127.0.0.1:8787/mcp');
    expect(ok).toBe(true);
    const config = fs.readFileSync(path.join(home, 'config.yaml'), 'utf-8');
    expect(config).toContain('mcp_servers:');
    expect(config).toContain('umbra:');
    expect(config).toContain('url: http://127.0.0.1:8787/mcp');
  });

  it('skips registration when umbra is already configured', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'umbra-hermes-home-'));
    fs.writeFileSync(
      path.join(home, 'config.yaml'),
      '# my config\r\nmcp_servers:\r\n  umbra:\r\n    url: http://127.0.0.1:8787/mcp\r\n  other:\r\n    url: http://x/mcp\r\n',
      'utf-8',
    );
    const before = fs.readFileSync(path.join(home, 'config.yaml'), 'utf-8');
    const bridge = new HermesAgentBridge({ bin: fakeBin, hermesHome: home });
    const ok = await bridge.registerMcpBridge('http://127.0.0.1:9999/mcp');
    expect(ok).toBe(true);
    // Existing config untouched; the original URL is preserved.
    expect(fs.readFileSync(path.join(home, 'config.yaml'), 'utf-8')).toBe(before);
  });

  it('adds umbra to an existing mcp_servers section', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'umbra-hermes-home-'));
    fs.writeFileSync(
      path.join(home, 'config.yaml'),
      'mcp_servers:\r\n  other:\r\n    url: http://x/mcp\r\nmodel:\r\n  default: x\r\n',
      'utf-8',
    );
    const bridge = new HermesAgentBridge({ bin: fakeBin, hermesHome: home });
    const ok = await bridge.registerMcpBridge('http://127.0.0.1:8787/mcp');
    expect(ok).toBe(true);
    const config = fs.readFileSync(path.join(home, 'config.yaml'), 'utf-8');
    expect(config).toContain('other:');
    expect(config).toContain('umbra:');
    expect(config).toContain('url: http://127.0.0.1:8787/mcp');
  });

  it('returns false when the engine is not installed', async () => {
    const bridge = new HermesAgentBridge({ bin: 'definitely-not-a-real-hermes-bin' });
    expect(await bridge.registerMcpBridge('http://127.0.0.1:8787/mcp')).toBe(false);
  });

  it('provisions provider keys into the engine .env', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'umbra-hermes-home-'));
    const bridge = new HermesAgentBridge({ bin: fakeBin, hermesHome: home });
    const ok = await bridge.syncProviderCredentials({ OPENAI_API_KEY: 'sk-test-123' });
    expect(ok).toBe(true);
    const env = fs.readFileSync(path.join(home, '.env'), 'utf-8');
    expect(env).toContain('OPENAI_API_KEY=sk-test-123');
  });

  it('upserts an existing key without duplicating lines', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'umbra-hermes-home-'));
    fs.writeFileSync(path.join(home, '.env'), '# engine env\r\nOPENAI_API_KEY=old\r\nOTHER=keep\r\n', 'utf-8');
    const bridge = new HermesAgentBridge({ bin: fakeBin, hermesHome: home });
    await bridge.syncProviderCredentials({ OPENAI_API_KEY: 'sk-new-456' });
    const env = fs.readFileSync(path.join(home, '.env'), 'utf-8');
    expect(env).toContain('OPENAI_API_KEY=sk-new-456');
    expect(env).toContain('OTHER=keep');
    expect(env.match(/OPENAI_API_KEY=/g)).toHaveLength(1);
  });

  it('ignores empty credential values', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'umbra-hermes-home-'));
    const bridge = new HermesAgentBridge({ bin: fakeBin, hermesHome: home });
    const ok = await bridge.syncProviderCredentials({ OPENAI_API_KEY: '  ' });
    expect(ok).toBe(true);
    expect(fs.existsSync(path.join(home, '.env'))).toBe(false);
  });
});