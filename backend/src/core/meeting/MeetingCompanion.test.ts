import { MeetingCompanion } from './MeetingCompanion';

function make(overrides: Partial<ConstructorParameters<typeof MeetingCompanion>[0]> = {}) {
  return new MeetingCompanion({
    stt: { transcribe: jest.fn().mockResolvedValue({ text: 'hello from meeting' }) },
    recorder: { record: jest.fn().mockResolvedValue(Buffer.from('wav')) },
    onJoin: jest.fn().mockResolvedValue('opened chrome'),
    onExecute: jest.fn().mockResolvedValue('did action'),
    summarize: jest.fn().mockResolvedValue('meeting summary'),
    ...overrides,
  } as any);
}

describe('MeetingCompanion', () => {
  it('joins a meeting and dispatches to the browser', async () => {
    const c = make();
    const s = await c.join('https://meet.example/abc');
    expect(s.status).toBe('joined');
    expect(s.url).toBe('https://meet.example/abc');
  });

  it('feeds audio into the live transcript', async () => {
    const c = make();
    await c.join('https://meet.example/abc');
    const seg = await c.feedAudio(Buffer.from('audio'), 'wav');
    expect(seg.text).toBe('hello from meeting');
    expect(c.status()!.transcript).toHaveLength(1);
  });

  it('executes a desktop action while in the meeting', async () => {
    const c = make();
    await c.join('https://meet.example/abc');
    const res = await c.execute('share_screen', {});
    expect(res).toBe('did action');
  });

  it('leaves and produces summary + action items from the transcript', async () => {
    const c = make({
      stt: { transcribe: jest.fn().mockResolvedValue({ text: 'I will send the report by Friday' }) },
    });
    await c.join('https://meet.example/abc');
    await c.feedAudio(Buffer.from('audio'), 'wav');
    const out = await c.leave();
    expect(out.summary).toBe('meeting summary');
    expect(out.session.status).toBe('left');
    expect(out.actionItems.length).toBeGreaterThanOrEqual(1);
  });

  it('rejects a second join while already in a meeting', async () => {
    const c = make();
    await c.join('https://a.example');
    await expect(c.join('https://b.example')).rejects.toThrow(/Already in a meeting/);
  });

  it('requires an STT engine + recorder to start listening', async () => {
    const c = make({ stt: undefined, recorder: undefined });
    await c.join('https://meet.example/abc');
    expect(() => c.startListening()).toThrow(/needs a loopback recorder/);
  });

  it('executes orders heard in the transcript', async () => {
    const onShareScreen = jest.fn().mockResolvedValue('sharing now');
    const c = make({
      stt: { transcribe: jest.fn().mockResolvedValue({ text: 'Hey Umbra, share your screen' }) },
      onShareScreen,
    });
    await c.join('https://meet.example/abc');
    await c.feedAudio(Buffer.from('audio'), 'wav');
    expect(onShareScreen).toHaveBeenCalled();
    expect(c.status()!.sharing).toBe(true);
    const orders = c.getOrders();
    expect(orders).toHaveLength(1);
    expect(orders[0].intent).toBe('share_screen');
    expect(orders[0].status).toBe('done');
  });

  it('records a note order and keeps it in-session', async () => {
    const c = make({
      stt: { transcribe: jest.fn().mockResolvedValue({ text: 'Ok umbra take a note about the deadline' }) },
    });
    await c.join('https://meet.example/abc');
    await c.feedAudio(Buffer.from('audio'), 'wav');
    expect(c.getNotes()).toContain('take a note about the deadline');
  });

  it('does not execute orders when ordersEnabled is false', async () => {
    const onShareScreen = jest.fn().mockResolvedValue('sharing now');
    const c = make({
      stt: { transcribe: jest.fn().mockResolvedValue({ text: 'Hey Umbra, share your screen' }) },
      onShareScreen,
      ordersEnabled: false,
    });
    await c.join('https://meet.example/abc');
    await c.feedAudio(Buffer.from('audio'), 'wav');
    expect(onShareScreen).not.toHaveBeenCalled();
    expect(c.getOrders()).toHaveLength(0);
  });

  it('shares and stops sharing via explicit calls', async () => {
    const onShareScreen = jest.fn().mockResolvedValue('sharing now');
    const onStopShare = jest.fn().mockResolvedValue('stopped');
    const c = make({ onShareScreen, onStopShare });
    await c.join('https://meet.example/abc');
    expect(await c.shareScreen('screen')).toBe('sharing now');
    expect(c.status()!.sharing).toBe(true);
    expect(await c.stopShare()).toBe('stopped');
    expect(c.status()!.sharing).toBe(false);
  });

  it('falls back to onExecute for screen sharing when no onShareScreen is set', async () => {
    const onExecute = jest.fn().mockResolvedValue('did action');
    const c = make({ onExecute });
    await c.join('https://meet.example/abc');
    await c.shareScreen();
    expect(onExecute).toHaveBeenCalledWith('share_screen', { target: undefined });
  });

  it('speaks a reply when a say order is heard', async () => {
    const onSpeak = jest.fn().mockResolvedValue('Spoke');
    const c = make({
      stt: { transcribe: jest.fn().mockResolvedValue({ text: 'Hey Umbra, say hello to everyone' }) },
      onSpeak,
    });
    await c.join('https://meet.example/abc');
    await c.feedAudio(Buffer.from('audio'), 'wav');
    expect(onSpeak).toHaveBeenCalledWith('hello to everyone', undefined);
    const orders = c.getOrders();
    expect(orders[0].intent).toBe('say');
    expect(orders[0].status).toBe('done');
  });

  it('mutes/unmutes the mic and raises/lowers the hand via onMeetingControl', async () => {
    const onMeetingControl = jest.fn().mockResolvedValue('done');
    const c = make({ onMeetingControl });
    await c.join('https://meet.example/abc');
    expect(await c.muteMic(true)).toBe('done');
    expect(await c.muteMic(false)).toBe('done');
    expect(await c.raiseHand(true)).toBe('done');
    expect(await c.raiseHand(false)).toBe('done');
    expect(onMeetingControl).toHaveBeenNthCalledWith(1, 'mute');
    expect(onMeetingControl).toHaveBeenNthCalledWith(2, 'unmute');
    expect(onMeetingControl).toHaveBeenNthCalledWith(3, 'raise_hand');
    expect(onMeetingControl).toHaveBeenNthCalledWith(4, 'lower_hand');
  });

  it('sends a chat message via onChatMessage', async () => {
    const onChatMessage = jest.fn().mockResolvedValue('sent');
    const c = make({ onChatMessage });
    await c.join('https://meet.example/abc');
    expect(await c.sendChat('we will be late')).toBe('sent');
    expect(onChatMessage).toHaveBeenCalledWith('we will be late');
  });

  it('executes mute / raise-hand / chat orders heard in the transcript', async () => {
    const onMeetingControl = jest.fn().mockResolvedValue('done');
    const onChatMessage = jest.fn().mockResolvedValue('sent');
    const stt = {
      transcribe: jest.fn()
        .mockResolvedValueOnce({ text: 'Hey Umbra, mute your mic' })
        .mockResolvedValueOnce({ text: 'Ok umbra raise your hand' })
        .mockResolvedValueOnce({ text: 'Umbra, send a message in the chat saying we will be late' }),
    };
    const c = make({ stt, onMeetingControl, onChatMessage });
    await c.join('https://meet.example/abc');
    await c.feedAudio(Buffer.from('a'), 'wav');
    await c.feedAudio(Buffer.from('b'), 'wav');
    await c.feedAudio(Buffer.from('c'), 'wav');
    expect(onMeetingControl).toHaveBeenCalledWith('mute');
    expect(onMeetingControl).toHaveBeenCalledWith('raise_hand');
    expect(onChatMessage).toHaveBeenCalled();
    const intents = c.getOrders().map(o => o.intent);
    expect(intents).toContain('mute');
    expect(intents).toContain('raise_hand');
    expect(intents).toContain('chat');
  });

  it('exposes attendees from diarized transcript speakers', async () => {
    const diarize = {
      transcribe: jest.fn().mockResolvedValue([
        { speaker: 'SPEAKER_00', text: 'hi', startMs: 0, endMs: 100 },
        { speaker: 'SPEAKER_01', text: 'hey', startMs: 200, endMs: 300 },
        { speaker: 'SPEAKER_00', text: 'again', startMs: 400, endMs: 500 },
      ]),
    };
    const c = make({ diarize, stt: undefined });
    await c.join('https://meet.example/abc');
    await c.feedAudio(Buffer.from('audio'), 'wav');
    expect(c.getAttendees()).toEqual(['SPEAKER_00', 'SPEAKER_01']);
  });

  it('speak() delegates to onSpeak or falls back to onExecute', async () => {
    const onSpeak = jest.fn().mockResolvedValue('Spoke');
    const a = make({ onSpeak });
    await a.join('https://meet.example/abc');
    expect(await a.speak('hi')).toBe('Spoke');

    const onExecute = jest.fn().mockResolvedValue('spoke via executor');
    const b = make({ onExecute });
    await b.join('https://meet.example/abc');
    expect(await b.speak('hi')).toBe('spoke via executor');
    expect(onExecute).toHaveBeenCalledWith('speak', { text: 'hi' });
  });

  it('ingests diarized segments with per-speaker labels and timestamps', async () => {
    const diarize = {
      transcribe: jest.fn().mockResolvedValue([
        { speaker: 'SPEAKER_00', text: 'Hello everyone', startMs: 0, endMs: 1000 },
        { speaker: 'SPEAKER_01', text: 'Good morning', startMs: 1200, endMs: 2000 },
      ]),
    };
    const c = make({ diarize, stt: undefined });
    await c.join('https://meet.example/abc');
    const seg = await c.feedAudio(Buffer.from('audio'), 'wav');
    const transcript = c.status()!.transcript;
    expect(transcript).toHaveLength(2);
    expect(transcript[0].speaker).toBe('SPEAKER_00');
    expect(transcript[1].speaker).toBe('SPEAKER_01');
    expect(transcript[1].startMs).toBe(1200);
    expect(transcript[1].endMs).toBe(2000);
    expect(seg.speaker).toBe('SPEAKER_01'); // feedAudio returns the last appended segment
  });

  it('executes orders heard in diarized segments', async () => {
    const onShareScreen = jest.fn().mockResolvedValue('sharing now');
    const diarize = {
      transcribe: jest.fn().mockResolvedValue([
        { speaker: 'SPEAKER_00', text: 'Hey Umbra, share your screen', startMs: 0, endMs: 1500 },
      ]),
    };
    const c = make({ diarize, stt: undefined, onShareScreen });
    await c.join('https://meet.example/abc');
    await c.feedAudio(Buffer.from('audio'), 'wav');
    expect(onShareScreen).toHaveBeenCalled();
    expect(c.getOrders()[0].intent).toBe('share_screen');
  });

  it('startListening accepts a diarizer in place of STT', async () => {
    jest.useFakeTimers();
    try {
      const c = make({
        stt: undefined,
        diarize: { transcribe: jest.fn().mockResolvedValue([]) },
      });
      await c.join('https://meet.example/abc');
      expect(() => c.startListening()).not.toThrow();
      c.stopListening();
    } finally {
      jest.clearAllTimers();
      jest.useRealTimers();
    }
  });

  it('still requires a recorder even with a diarizer', async () => {
    const c = make({ stt: undefined, recorder: undefined, diarize: { transcribe: jest.fn() } });
    await c.join('https://meet.example/abc');
    expect(() => c.startListening()).toThrow(/loopback recorder/);
  });
});
