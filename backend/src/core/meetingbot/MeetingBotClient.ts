import { getLogger } from '../Logger';

const DEFAULT_BOT_URL = 'http://127.0.0.1:8000';

export interface MeetingBotConfig {
  /** Base URL of the meeting bot service (default http://127.0.0.1:8000) */
  botUrl?: string;
  /** Plan: 'free' | 'pro' | 'advanced' */
  plan?: string;
}

export interface JoinMeetingRequest {
  meeting_url: string;
  platform: 'google_meet' | 'teams';
  bot_name?: string;
}

export interface BotStatus {
  state: 'idle' | 'joining' | 'in_meeting' | 'leaving' | 'error';
  meeting_url?: string;
  uptime_seconds?: number;
  transcript_lines?: number;
  error?: string;
}

export class MeetingBotClient {
  private botUrl: string;
  private plan: string;
  private logger = getLogger();

  constructor(config: MeetingBotConfig = {}) {
    this.botUrl = (config.botUrl || DEFAULT_BOT_URL).replace(/\/$/, '');
    this.plan = config.plan || 'free';
  }

  /** Check if the meeting bot service is reachable. */
  async healthCheck(): Promise<boolean> {
    try {
      const res = await fetch(`${this.botUrl}/health`, { signal: AbortSignal.timeout(3000) });
      return res.ok;
    } catch {
      return false;
    }
  }

  /** Join a meeting with the bot. */
  async joinMeeting(req: JoinMeetingRequest): Promise<unknown> {
    this.logger.info({ url: req.meeting_url, platform: req.platform }, 'Meeting bot: joining meeting');
    const res = await fetch(`${this.botUrl}/bot/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        meeting_url: req.meeting_url,
        platform: req.platform,
        bot_name: req.bot_name || 'Umbra Bot',
        plan: this.plan,
      }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Meeting bot join failed: ${res.status} ${text}`);
    }
    return res.json();
  }

  /** Leave the current meeting. */
  async leaveMeeting(): Promise<unknown> {
    this.logger.info('Meeting bot: leaving meeting');
    const res = await fetch(`${this.botUrl}/bot/leave`, {
      method: 'POST',
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Meeting bot leave failed: ${res.status} ${text}`);
    }
    return res.json();
  }

  /** Get current bot status. */
  async getStatus(): Promise<BotStatus> {
    try {
      const res = await fetch(`${this.botUrl}/bot/status`, { signal: AbortSignal.timeout(3000) });
      if (!res.ok) return { state: 'error', error: `HTTP ${res.status}` };
      return res.json() as Promise<BotStatus>;
    } catch (err) {
      return { state: 'error', error: err instanceof Error ? err.message : 'unreachable' };
    }
  }

  /** Get full transcript. */
  async getTranscript(): Promise<string> {
    try {
      const res = await fetch(`${this.botUrl}/bot/transcript`, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) return '';
      const data = await res.json() as { transcript?: string };
      return data.transcript || '';
    } catch {
      return '';
    }
  }

  /** Send a command to the bot. */
  async sendCommand(command: string, args?: Record<string, unknown>): Promise<unknown> {
    const res = await fetch(`${this.botUrl}/bot/command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command, args }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Meeting bot command failed: ${res.status} ${text}`);
    }
    return res.json();
  }
}
