import { ScreenAwareness } from './ScreenAwareness';
import { ScreenReader } from '../vision/ScreenReader';

const fakeLlm = {
  complete: jest.fn().mockResolvedValue({ content: 'the answer', modelUsed: 'm', totalTokens: 1, finishReason: 'stop' }),
};

const fakeReader = {
  ocrImage: jest.fn().mockResolvedValue('screen text here'),
} as unknown as ScreenReader;

const capture = jest.fn().mockResolvedValue({
  buffer: Buffer.from('fake-png'),
  width: 1280,
  height: 720,
  capturedAt: Date.now(),
});

function make(overrides: Partial<ConstructorParameters<typeof ScreenAwareness>[0]> = {}) {
  return new ScreenAwareness({
    llm: fakeLlm as any,
    screenReader: fakeReader,
    capture,
    getWindow: () => ({ appName: 'chrome.exe', windowTitle: 'GitHub' }),
    getCursor: () => ({ x: 100, y: 200 }),
    ...overrides,
  });
}

describe('ScreenAwareness', () => {
  beforeEach(() => {
    fakeLlm.complete.mockClear();
    (fakeReader.ocrImage as jest.Mock).mockClear();
  });

  it('captures a snapshot with OCR text, window and cursor', async () => {
    const a = make();
    const s = await a.snapshot();
    expect(s).not.toBeNull();
    expect(s!.snapshot.ocrText).toBe('screen text here');
    expect(s!.snapshot.cursor).toEqual({ x: 100, y: 200 });
    expect(s!.snapshot.appName).toBe('chrome.exe');
    expect(s!.snapshot.window).toBe('GitHub');
  });

  it('answers a question using the vision model with a screenshot', async () => {
    const a = make();
    const r = await a.ask('what is this error?', 'answer');
    expect(r.answer).toBe('the answer');
    expect(r.usedVision).toBe(true);
    expect(fakeLlm.complete.mock.calls[0][1]).toBe('vision');
  });

  it('falls back to text-only when the vision call fails', async () => {
    fakeLlm.complete.mockImplementationOnce(() => { throw new Error('no vision model'); });
    const a = make();
    const r = await a.ask('help me finish', 'help');
    expect(r.usedVision).toBe(false);
    expect(r.answer).toBe('the answer');
    expect(fakeLlm.complete.mock.calls[1][1]).toBe('reasoning');
  });

  it('returns a graceful answer when capture fails', async () => {
    capture.mockResolvedValueOnce(null);
    const a = make();
    const r = await a.ask('anything', 'answer');
    expect(r.answer).toMatch(/could not capture/i);
    expect(r.usedVision).toBe(false);
  });

  it('supports the finish intent (help me finish this task)', async () => {
    const a = make();
    const r = await a.ask('finish this', 'finish');
    expect(r.intent).toBe('finish');
    expect(r.usedVision).toBe(true);
  });

  it('watches the screen: start/stop + latest view from the watch loop', async () => {
    const a = make();
    expect(a.isWatching).toBe(false);
    a.startWatching(60_000);
    expect(a.isWatching).toBe(true);

    await a.refresh();
    const latest = a.latest();
    expect(latest).not.toBeNull();
    expect(latest!.snapshot.appName).toBe('chrome.exe');

    a.stopWatching();
    expect(a.isWatching).toBe(false);
  });

  it('tracks a cursor trail while following the cursor', async () => {
    let x = 0;
    const a = make({ getCursor: () => ({ x: x, y: 0 }) });
    await a.snapshot();
    x = 50;
    await a.snapshot();
    x = 100;
    await a.snapshot();
    const trail = a.cursorTrail();
    expect(trail.length).toBe(3);
    expect(trail[trail.length - 1].x).toBe(100);
  });
});
