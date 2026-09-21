import { WhisperAsr } from './WhisperAsr';

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

describe('WhisperAsr', () => {
  it('defaults to the whisper server port', async () => {
    const fetchFn = jest.fn().mockResolvedValue(jsonResponse({ ok: true, state: 'ready', model: 'faster-whisper/small' }));
    const asr = new WhisperAsr({ fetchFn: fetchFn as any });
    expect(await asr.isRunning()).toBe(true);
    expect(fetchFn).toHaveBeenCalledWith('http://127.0.0.1:17501/health', expect.objectContaining({}));
  });

  it('honors an explicit baseUrl override', async () => {
    const fetchFn = jest.fn().mockResolvedValue(jsonResponse({ ok: false, state: 'loading' }));
    const asr = new WhisperAsr({ baseUrl: 'http://127.0.0.1:9999', fetchFn: fetchFn as any });
    await asr.health();
    expect(fetchFn).toHaveBeenCalledWith('http://127.0.0.1:9999/health', expect.objectContaining({}));
  });

  it('parses diarized segments from /transcribe', async () => {
    const fetchFn = jest.fn().mockResolvedValue(jsonResponse({
      segments: [
        { speaker_id: 'SPEAKER_00', start_time: 0, end_time: 1.2, text: 'Hey Umbra' },
        { speaker_id: 'SPEAKER_01', start_time: 1.4, end_time: 2.8, text: 'Take a note' },
      ],
    }));
    const asr = new WhisperAsr({ fetchFn: fetchFn as any });
    const segments = await asr.transcribe(Buffer.from('wav'));
    expect(segments.map(s => s.speaker)).toEqual(['SPEAKER_00', 'SPEAKER_01']);
  });
});
