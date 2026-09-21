import { VibeVoiceAsr, parseDiarizedSegments } from './VibeVoiceAsr';

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

describe('parseDiarizedSegments', () => {
  it('normalizes server segments to speaker/text/ms', () => {
    const parsed = parseDiarizedSegments([
      { speaker_id: 'SPEAKER_00', start_time: 0.0, end_time: 1.25, text: 'Hello everyone' },
      { speaker_id: 'SPEAKER_01', start_time: 1.5, end_time: 3.0, text: 'Good morning' },
    ]);
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toEqual({ speaker: 'SPEAKER_00', text: 'Hello everyone', startMs: 0, endMs: 1250 });
    expect(parsed[1].startMs).toBe(1500);
  });

  it('handles capitalized keys, missing values and junk', () => {
    const parsed = parseDiarizedSegments([
      { 'Speaker ID': 'A', 'Start': 2, 'End': 4, Content: 'hi' },
      { speaker_id: 'B', start_time: 5, end_time: 6 }, // no text -> dropped
      'garbage',
    ]);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].speaker).toBe('A');
  });

  it('returns [] for non-arrays', () => {
    expect(parseDiarizedSegments(null)).toEqual([]);
    expect(parseDiarizedSegments({})).toEqual([]);
  });
});

describe('VibeVoiceAsr', () => {
  it('isRunning reads /health', async () => {
    const fetchFn = jest.fn().mockResolvedValue(jsonResponse({ ok: true, model: 'microsoft/VibeVoice-ASR' }));
    const asr = new VibeVoiceAsr({ fetchFn: fetchFn as any });
    expect(await asr.isRunning()).toBe(true);
    expect(fetchFn).toHaveBeenCalledWith('http://127.0.0.1:17500/health', expect.objectContaining({}));
  });

  it('health returns the full report and distinguishes loading from ready', async () => {
    const fetchFn = jest.fn().mockResolvedValue(jsonResponse({ ok: false, state: 'loading', device: 'cpu' }));
    const asr = new VibeVoiceAsr({ fetchFn: fetchFn as any });
    expect(await asr.health()).toEqual({ ok: false, state: 'loading', device: 'cpu' });
    expect(await asr.isRunning()).toBe(false);
  });

  it('health returns null when the server is unreachable', async () => {
    const fetchFn = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const asr = new VibeVoiceAsr({ fetchFn: fetchFn as any });
    expect(await asr.health()).toBeNull();
    expect(await asr.isRunning()).toBe(false);
  });

  it('transcribe posts multipart audio and returns segments', async () => {
    const fetchFn = jest.fn().mockResolvedValue(jsonResponse({
      segments: [{ speaker_id: 'SPEAKER_00', start_time: 0, end_time: 1.5, text: 'hey' }],
    }));
    const asr = new VibeVoiceAsr({ fetchFn: fetchFn as any });
    const segments = await asr.transcribe(Buffer.from('wav'), { context: 'Speakers: Alice' });
    expect(segments).toHaveLength(1);
    expect(segments[0].speaker).toBe('SPEAKER_00');
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:17500/transcribe');
    expect(init.method).toBe('POST');
  });

  it('propagates server errors', async () => {
    const fetchFn = jest.fn().mockResolvedValue(jsonResponse({ error: 'model not loaded yet' }, 200));
    const asr = new VibeVoiceAsr({ fetchFn: fetchFn as any });
    await expect(asr.transcribe(Buffer.from('wav'))).rejects.toThrow(/model not loaded/);
  });
});
