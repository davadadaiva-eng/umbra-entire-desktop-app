/**
 * MeetingCompanion — attends a meeting like a participant: joins via the real
 * browser, "hears" the meeting audio (loopback capture → STT → live
 * transcript), can take actions on the desktop while the meeting runs, and on
 * leaving produces a summary + action items via MeetingAgent.
 *
 * It also takes orders: while listening it scans the transcript for commands
 * addressed to the assistant ("Hey Umbra, share your screen", "Ok Umbra, take
 * a note...") and executes them in real time — sharing the screen, taking
 * notes, running searches, or driving the desktop like a normal user.
 *
 * Audio is decoupled from transcription so the companion works with any
 * source: the built-in WASAPI loopback recorder, a VB-Cable/Stereo Mix route
 * into the mic, or audio pushed in through feedAudio()/the API.
 */
import { MeetingAgent, TranscriptSegment, MeetingOutcome } from './MeetingAgent';
import { MeetingOrder, detectOrders } from './MeetingOrders';
import { LoopbackRecorder } from '../audio/LoopbackRecorder';
import { eventBus } from '../EventBus';
import { getLogger } from '../Logger';

export type MeetingStatus = 'joining' | 'joined' | 'listening' | 'left';

/** A speaker-labeled, timestamped transcript piece (VibeVoice-ASR diarization). */
export interface DiarizedSegment {
  speaker: string;
  text: string;
  startMs: number;
  endMs: number;
}

export interface MeetingSessionState {
  id: string;
  url: string;
  title: string;
  status: MeetingStatus;
  joinedAt: number;
  transcript: TranscriptSegment[];
  /** Orders that were heard and executed during the meeting. */
  orders: MeetingOrder[];
  /** Free-form notes the assistant captured while the meeting ran. */
  notes: string[];
  /** Whether the assistant is currently sharing the screen. */
  sharing: boolean;
  lastError?: string;
}

export type OrderDetector = (segment: TranscriptSegment, context: TranscriptSegment[]) => MeetingOrder[];

export interface MeetingCompanionOptions {
  /** Transcribes an audio buffer to text (SpeechToText-compatible shape). */
  stt?: { transcribe(audio: Buffer, format?: string): Promise<{ text: string }> };
  /**
   * Transcribes an audio buffer into speaker-labeled segments (VibeVoice-ASR
   * diarization). When set, this is used instead of `stt` for live capture.
   */
  diarize?: { transcribe(audio: Buffer, format?: string): Promise<DiarizedSegment[]> };
  recorder?: LoopbackRecorder;
  /** Opens the meeting in the real browser (e.g. RealDesktop2.openChrome). */
  onJoin?: (url: string) => Promise<string>;
  /** Runs a desktop action while in the meeting (e.g. realDesktop.executeAction). */
  onExecute?: (action: string, params: Record<string, unknown>) => Promise<string>;
  summarize?: (transcript: string) => Promise<string>;
  /** Share the meeting screen (DOM automation / ghost click). */
  onShareScreen?: (target?: string) => Promise<string>;
  /** Stop sharing the meeting screen. */
  onStopShare?: () => Promise<string>;
  /** Run a search without disturbing the meeting; returns the answer/text. */
  onSearch?: (query: string) => Promise<string>;
  /** Persist a note somewhere external (else it is kept in-session). */
  onNote?: (text: string) => Promise<string>;
  /** Persist a reminder somewhere external (else it is kept in-session). */
  onReminder?: (text: string) => Promise<string>;
  /** Speak a reply out loud (e.g. Windows SAPI TTS) during the meeting. */
  onSpeak?: (text: string, opts?: { voice?: string; language?: string }) => Promise<string>;
  /** Meeting UI control (mute/unmute mic, raise/lower hand) via DOM automation. */
  onMeetingControl?: (control: 'mute' | 'unmute' | 'raise_hand' | 'lower_hand') => Promise<string>;
  /** Send a message in the meeting chat via DOM automation. */
  onChatMessage?: (message: string) => Promise<string>;
  /** Seconds of audio captured per chunk. */
  chunkSec?: number;
  /** Detect + auto-execute orders from the transcript (default true). */
  ordersEnabled?: boolean;
  /** Custom order detector (defaults to trigger-phrase detection). */
  orderDetector?: OrderDetector;
}

export class MeetingCompanion {
  private session?: MeetingSessionState;
  private agent: MeetingAgent;
  private options: MeetingCompanionOptions;
  private listening: boolean = false;
  private listenTimer?: NodeJS.Timeout;
  private planId?: string;
  private ordersEnabled: boolean;

  constructor(options: MeetingCompanionOptions = {}) {
    this.options = options;
    this.ordersEnabled = options.ordersEnabled ?? true;
    this.agent = new MeetingAgent({ summarize: options.summarize });
  }

  get active(): boolean {
    return this.session !== undefined && this.session.status !== 'left';
  }

  status(): MeetingSessionState | null {
    return this.session ?? null;
  }

  getOrders(): MeetingOrder[] {
    return this.session ? this.session.orders.slice() : [];
  }

  getNotes(): string[] {
    return this.session ? this.session.notes.slice() : [];
  }

  async join(url: string, opts: { title?: string; topics?: string[] } = {}): Promise<MeetingSessionState> {
    if (this.active) throw new Error('Already in a meeting — leave first');

    this.session = {
      id: `mtg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      url,
      title: opts.title || url,
      status: 'joining',
      joinedAt: Date.now(),
      transcript: [],
      orders: [],
      notes: [],
      sharing: false,
    };

    if (this.options.onJoin) {
      const detail = await this.options.onJoin(url);
      getLogger().info({ url, detail }, 'Meeting join dispatched to the real browser');
    } else {
      getLogger().warn('No onJoin handler — open the meeting URL manually');
    }

    this.planId = this.agent.plan({
      title: this.session.title,
      topics: opts.topics,
      voiceMode: true,
      startAt: Date.now(),
    }).id;

    this.session.status = 'joined';
    return this.session;
  }

  /** Begin capturing meeting audio → transcript chunks (and execute orders). */
  startListening(): void {
    if (!this.session) throw new Error('Join a meeting first');
    if (!this.options.recorder) {
      throw new Error('Listening needs a loopback recorder (set meeting.loopbackEnabled)');
    }
    if (!this.options.stt && !this.options.diarize) {
      throw new Error('Listening needs an STT engine or diarizer (set voice.enabled + sttProvider, or voice.asrProvider=vibevoice)');
    }
    if (this.listening) return;
    this.listening = true;
    this.session.status = 'listening';
    getLogger().info({ session: this.session.id }, 'Meeting listening started');
    void this.loopOnce();
  }

  stopListening(): void {
    this.listening = false;
    if (this.listenTimer) {
      clearTimeout(this.listenTimer);
      this.listenTimer = undefined;
    }
    if (this.session && this.session.status === 'listening') {
      this.session.status = 'joined';
    }
    getLogger().info('Meeting listening stopped');
  }

  /** Push externally-captured audio into the transcript (any source). */
  async feedAudio(audio: Buffer, format: string = 'wav'): Promise<TranscriptSegment> {
    if (!this.session) throw new Error('Join a meeting first');
    if (this.options.diarize) {
      const segments = await this.options.diarize.transcribe(audio, format);
      const added = await this.ingestDiarized(segments, Date.now());
      if (!added.length) throw new Error('No speech detected in the audio');
      return added[added.length - 1];
    }
    if (!this.options.stt) throw new Error('No STT engine configured');
    const { text } = await this.options.stt.transcribe(audio, format);
    return this.ingest(text);
  }

  /** Run a desktop action while the meeting is live (like a normal user). */
  async execute(action: string, params: Record<string, unknown>): Promise<string> {
    if (!this.session) throw new Error('Join a meeting first');
    if (!this.options.onExecute) throw new Error('No desktop executor configured');
    return this.options.onExecute(action, params);
  }

  /** Share the meeting screen (delegates to onShareScreen / onExecute). */
  async shareScreen(target?: string): Promise<string> {
    if (!this.session) throw new Error('Join a meeting first');
    if (this.session.sharing) return 'Already sharing the screen';
    let result: string;
    if (this.options.onShareScreen) {
      result = await this.options.onShareScreen(target);
    } else if (this.options.onExecute) {
      result = await this.options.onExecute('share_screen', { target });
    } else {
      throw new Error('No screen-share executor configured');
    }
    this.session.sharing = true;
    return result;
  }

  /** Stop sharing the meeting screen. */
  async stopShare(): Promise<string> {
    if (!this.session) throw new Error('Join a meeting first');
    if (!this.session.sharing) return 'Not currently sharing';
    let result: string;
    if (this.options.onStopShare) {
      result = await this.options.onStopShare();
    } else if (this.options.onExecute) {
      result = await this.options.onExecute('stop_share', {});
    } else {
      throw new Error('No screen-share executor configured');
    }
    this.session.sharing = false;
    return result;
  }

  /** Speak a reply out loud (delegates to onSpeak, else onExecute('speak')). */
  async speak(text: string, opts?: { voice?: string; language?: string }): Promise<string> {
    if (!this.session) throw new Error('Join a meeting first');
    if (this.options.onSpeak) return this.options.onSpeak(text, opts);
    if (this.options.onExecute) return this.options.onExecute('speak', { text, ...opts });
    throw new Error('No TTS/speaker configured (set meeting.tts to local or vibevoice)');
  }

  /** Mute/unmute the local mic (delegates to onMeetingControl, else onExecute). */
  async muteMic(muted: boolean): Promise<string> {
    if (!this.session) throw new Error('Join a meeting first');
    const control = muted ? 'mute' : 'unmute';
    if (this.options.onMeetingControl) return this.options.onMeetingControl(control);
    if (this.options.onExecute) return this.options.onExecute(control === 'mute' ? 'meeting_mute' : 'meeting_unmute', {});
    throw new Error('No meeting control handler configured');
  }

  /** Raise/lower the virtual hand (delegates to onMeetingControl, else onExecute). */
  async raiseHand(raised: boolean): Promise<string> {
    if (!this.session) throw new Error('Join a meeting first');
    const control = raised ? 'raise_hand' : 'lower_hand';
    if (this.options.onMeetingControl) return this.options.onMeetingControl(control);
    if (this.options.onExecute) return this.options.onExecute(raised ? 'meeting_raise_hand' : 'meeting_lower_hand', {});
    throw new Error('No meeting control handler configured');
  }

  /** Send a message in the meeting chat (delegates to onChatMessage, else onExecute). */
  async sendChat(message: string): Promise<string> {
    if (!this.session) throw new Error('Join a meeting first');
    if (this.options.onChatMessage) return this.options.onChatMessage(message);
    if (this.options.onExecute) return this.options.onExecute('meeting_chat', { message });
    throw new Error('No chat handler configured');
  }

  /** Unique speaker labels seen in the transcript (diarization-friendly). */
  getAttendees(): string[] {
    if (!this.session) return [];
    return [...new Set(this.session.transcript.map(s => s.speaker).filter(Boolean))];
  }

  /**
   * Detect and execute the orders in one transcript segment. Public so an API
   * or the audio loop can run it explicitly; feedAudio/startListening already
   * call it automatically.
   */
  async processOrders(segment: TranscriptSegment): Promise<MeetingOrder[]> {
    if (!this.session || !this.ordersEnabled) return [];
    const detector = this.options.orderDetector ?? detectOrders;
    const orders = detector(segment, this.session.transcript);
    for (const order of orders) {
      await this.runOrder(order);
    }
    return orders;
  }

  /** Execute a single detected (or API-submitted) order. */
  async runOrder(order: MeetingOrder): Promise<MeetingOrder> {
    if (!this.session) throw new Error('Join a meeting first');
    this.session.orders.push(order);
    order.status = 'running';
    try {
      order.result = await this.dispatchOrder(order);
      order.status = 'done';
    } catch (err: any) {
      order.status = 'failed';
      order.error = err.message;
    }
    getLogger().info({ intent: order.intent, status: order.status }, 'Meeting order processed');
    eventBus.emit('meeting:order', {
      id: order.id, intent: order.intent, text: order.text, speaker: order.speaker,
      status: order.status, result: order.result, error: order.error,
    });
    return order;
  }

  /** Leave the meeting and produce the summary + action items. */
  async leave(): Promise<MeetingOutcome & { session: MeetingSessionState }> {
    if (!this.session) throw new Error('No active meeting');
    this.stopListening();
    const planId = this.planId || this.session.id;
    this.session.status = 'left';
    const outcome = await this.agent.closeMeeting(planId, this.session.transcript);
    getLogger().info({ session: this.session.id, actions: outcome.actionItems.length }, 'Meeting closed');
    return { ...outcome, session: this.session };
  }

  private async dispatchOrder(order: MeetingOrder): Promise<string> {
    switch (order.intent) {
      case 'share_screen':
        return this.shareScreen();
      case 'stop_share':
        return this.stopShare();
      case 'note':
        return this.recordNote(order.text);
      case 'search':
        return this.runSearch(order.text);
      case 'reminder':
        return this.recordReminder(order.text);
      case 'say':
        return this.speak(order.text.replace(/^say\s+/i, ''));
      case 'mute':
        return this.muteMic(true);
      case 'unmute':
        return this.muteMic(false);
      case 'raise_hand':
        return this.raiseHand(true);
      case 'lower_hand':
        return this.raiseHand(false);
      case 'chat':
        return this.sendChat(order.text.replace(/^[^:]*?(?:chat|message)\s*/i, '').trim() || order.text);
      case 'execute':
      default:
        if (this.options.onExecute) {
          return this.options.onExecute('agent_task', { task: order.text });
        }
        return 'Order received but no desktop executor is configured';
    }
  }

  private async recordNote(text: string): Promise<string> {
    const note = text.trim();
    if (note) this.session!.notes.push(note);
    if (this.options.onNote) return this.options.onNote(note);
    return `Note recorded: ${note || '(empty)'}`;
  }

  private async recordReminder(text: string): Promise<string> {
    const reminder = `Reminder: ${text.trim()}`;
    this.session!.notes.push(reminder);
    if (this.options.onReminder) return this.options.onReminder(text.trim());
    return reminder;
  }

  private async runSearch(query: string): Promise<string> {
    if (this.options.onSearch) {
      return this.options.onSearch(query.trim());
    }
    return `Search requested (no search handler configured): ${query.trim()}`;
  }

  private async loopOnce(): Promise<void> {
    if (!this.listening || !this.session) return;
    const chunkSec = this.options.chunkSec ?? 12;
    const chunkStartedAt = Date.now();
    try {
      const audio = await this.options.recorder!.record(chunkSec);
      if (this.options.diarize) {
        const segments = await this.options.diarize.transcribe(audio, 'wav');
        if (segments.length) await this.ingestDiarized(segments, chunkStartedAt);
      } else {
        const { text } = await this.options.stt!.transcribe(audio, 'wav');
        if (text && text.trim()) await this.ingest(text);
      }
    } catch (err: any) {
      if (this.session) this.session.lastError = err.message;
      getLogger().warn({ err: err.message }, 'Meeting listen chunk failed');
    }
    this.listenTimer = setTimeout(() => void this.loopOnce(), 500);
  }

  private async ingest(text: string): Promise<TranscriptSegment> {
    const segment = this.appendSegment(text);
    await this.processOrders(segment);
    return segment;
  }

  /** Append speaker-labeled diarized segments and run order detection on each. */
  private async ingestDiarized(segments: DiarizedSegment[], chunkStartedAt: number): Promise<TranscriptSegment[]> {
    const added: TranscriptSegment[] = [];
    for (const seg of segments) {
      const segment = this.appendDiarizedSegment(seg, chunkStartedAt);
      added.push(segment);
      await this.processOrders(segment);
    }
    return added;
  }

  private appendDiarizedSegment(seg: DiarizedSegment, chunkStartedAt: number): TranscriptSegment {
    const atMs = Math.max(0, chunkStartedAt - this.session!.joinedAt) + seg.startMs;
    const segment: TranscriptSegment = {
      speaker: seg.speaker,
      text: seg.text.trim(),
      atMs,
      startMs: seg.startMs,
      endMs: seg.endMs,
    };
    this.session!.transcript.push(segment);
    eventBus.emit('meeting:transcript', { speaker: segment.speaker, text: segment.text, atMs: segment.atMs });
    return segment;
  }

  private appendSegment(text: string): TranscriptSegment {
    const segment: TranscriptSegment = {
      speaker: 'meeting',
      text: text.trim(),
      atMs: Date.now() - this.session!.joinedAt,
    };
    this.session!.transcript.push(segment);
    eventBus.emit('meeting:transcript', { speaker: segment.speaker, text: segment.text, atMs: segment.atMs });
    return segment;
  }
}
