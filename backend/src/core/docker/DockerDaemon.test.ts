import { DockerDaemon } from './DockerDaemon';
import { TelnyxClient } from '../telco/TelnyxClient';
import { profileFor, FrameRate, blend, rgbaToBgr } from '../video/VideoKit';

describe('DockerDaemon', () => {
  it('runs and stops containers in dry-run mode', async () => {
    const docker = new DockerDaemon({ dryRun: true });
    const state = await docker.run({ name: 'worker-1', image: 'umbra/skill:latest', memoryLimitMb: 512 });
    expect(state.running).toBe(true);
    expect(docker.list()).toHaveLength(1);
    expect(await docker.stop('worker-1')).toBe(true);
    expect(docker.list()[0].running).toBe(false);
    expect(await docker.remove('worker-1')).toBe(true);
    expect(docker.list()).toHaveLength(0);
  });

  it('ensureImage succeeds in dry-run mode', async () => {
    const docker = new DockerDaemon({ dryRun: true });
    expect(await docker.ensureImage('umbra/skill:latest')).toBe(true);
  });
});

describe('TelnyxClient', () => {
  it('fails fast without a token', async () => {
    const client = new TelnyxClient({ fromNumber: '+1555' });
    const result = await client.sendSms({ to: '+1555', text: 'hi' });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/token/i);
  });

  it('resolves the token from the vault when configured', () => {
    const { CredentialVault } = require('../vault/CredentialVault');
    const vault = new CredentialVault({ dataDir: require('os').tmpdir(), hwid: 'telco-test' });
    vault.unlock();
    vault.set({ service: 'telnyx', username: 'u', secret: 'vault-token' });
    const client = new TelnyxClient({ fromNumber: '+1555', vault });
    expect(client.resolvedToken).toBe('vault-token');
  });
});

describe('VideoKit', () => {
  it('builds profiles from priority', () => {
    const quality = profileFor('quality');
    expect(quality.fps).toBe(FrameRate.HIGH);
    const power = profileFor('power');
    expect(power.fps).toBe(FrameRate.NORMAL);
  });

  it('blends and converts RGBA→BGR buffers', () => {
    const src = Buffer.from([255, 0, 0, 255, 0, 255, 0, 255]);
    const dst = Buffer.from([0, 0, 0, 255, 0, 0, 0, 255]);
    const blended = blend(src, dst, 1);
    expect(blended[0]).toBe(255);
    expect(blended[4]).toBe(0);

    const bgr = rgbaToBgr(src);
    expect(bgr[0]).toBe(0);
    expect(bgr[1]).toBe(0);
    expect(bgr[2]).toBe(255);
    expect(bgr[4]).toBe(0);
    expect(bgr[5]).toBe(255);
    expect(bgr[6]).toBe(0);
  });
});
