import { WindowsTts } from './WindowsTts';

describe('WindowsTts', () => {
  it('reports availability based on platform', () => {
    const tts = new WindowsTts('/tmp/umbra');
    expect(tts.available).toBe(process.platform === 'win32');
  });

  it('rejects speak() when SAPI is not available', async () => {
    if (process.platform === 'win32') return; // avoid actually speaking in CI
    const tts = new WindowsTts('/tmp/umbra');
    await expect(tts.speak('hello')).rejects.toThrow(/Windows only/);
  });

  it('rejects synthesize() when SAPI is not available', async () => {
    if (process.platform === 'win32') return; // avoid synthesizing in CI
    const tts = new WindowsTts('/tmp/umbra');
    await expect(tts.synthesize('hello')).rejects.toThrow(/Windows only/);
  });
});
