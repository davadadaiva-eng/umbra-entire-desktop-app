/**
 * Meeting Agent — attends meetings end-to-end: agenda, real-time digest,
 * action items, and follow-ups. Integrates with the skill stack (meeting-prep,
 * note-taking) and the telco bridge for voice-mode meetings.
 */

export interface MeetingAttendee {
  name: string;
  email?: string;
  role?: 'host' | 'attendee' | 'assistant';
}

export interface AgendaItem {
  id: string;
  topic: string;
  owner?: string;
  durationMin?: number;
  status: 'pending' | 'active' | 'done' | 'deferred';
}

export interface MeetingPlan {
  id: string;
  title: string;
  attendees: MeetingAttendee[];
  agenda: AgendaItem[];
  startAt: number;
  durationMin: number;
  voiceMode: boolean;
}

export interface MeetingOutcome {
  summary: string;
  actionItems: { text: string; owner?: string; dueAt?: number }[];
  decisions: string[];
}

export interface TranscriptSegment {
  speaker: string;
  text: string;
  atMs: number;
  /** Diarized offset within the source audio chunk (ms), when available. */
  startMs?: number;
  endMs?: number;
}

export interface MeetingAgentOptions {
  summarize?: (transcript: string) => Promise<string>;
}

export class MeetingAgent {
  private summarizeFn?: MeetingAgentOptions['summarize'];
  private plans = new Map<string, MeetingPlan>();

  constructor(options: MeetingAgentOptions = {}) {
    this.summarizeFn = options.summarize;
  }

  plan(input: {
    title: string;
    attendees?: MeetingAttendee[];
    topics?: string[];
    startAt?: number;
    durationMin?: number;
    voiceMode?: boolean;
  }): MeetingPlan {
    const plan: MeetingPlan = {
      id: `mtg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      title: input.title,
      attendees: input.attendees ?? [],
      agenda: (input.topics ?? ['Open discussion']).map((topic, i) => ({
        id: `a${i + 1}`,
        topic,
        status: i === 0 ? 'active' : 'pending',
      })),
      startAt: input.startAt ?? Date.now(),
      durationMin: input.durationMin ?? 30,
      voiceMode: input.voiceMode ?? false,
    };
    this.plans.set(plan.id, plan);
    return plan;
  }

  get(planId: string): MeetingPlan | undefined {
    return this.plans.get(planId);
  }

  /** Ingest transcript segments; emit action items + decisions. */
  async closeMeeting(planId: string, segments: TranscriptSegment[]): Promise<MeetingOutcome> {
    const plan = this.plans.get(planId);
    const transcript = segments.map(s => `${s.speaker}: ${s.text}`).join('\n');

    let summary: string;
    if (this.summarizeFn) {
      summary = await this.summarizeFn(transcript);
    } else {
      summary = this.extractiveSummary(transcript);
    }

    const actionItems = this.extractActionItems(segments, plan);
    const decisions = this.extractDecisions(segments);

    return { summary, actionItems, decisions };
  }

  private extractActionItems(segments: TranscriptSegment[], plan?: MeetingPlan): MeetingOutcome['actionItems'] {
    const items: MeetingOutcome['actionItems'] = [];
    for (const seg of segments) {
      const lower = seg.text.toLowerCase();
      const m = lower.match(/(?:^|[.!?]\s+)(i will|i'll|we will|i need to|(?:[a-z]+) will)(.*)/);
      if (m) {
        items.push({
          text: seg.text.trim(),
          owner: plan ? this.resolveOwner(plan, seg.speaker) : seg.speaker,
          dueAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
        });
      }
    }
    return items.slice(0, 10);
  }

  private extractDecisions(segments: TranscriptSegment[]): string[] {
    const decisions: string[] = [];
    for (const seg of segments) {
      if (/(we (agreed|decided)|decision|we're going with)/i.test(seg.text)) {
        decisions.push(seg.text.trim());
      }
    }
    return decisions.slice(0, 5);
  }

  private resolveOwner(plan: MeetingPlan, speaker: string): string | undefined {
    const attendee = plan.attendees.find(a => a.name === speaker);
    return attendee?.email || attendee?.name || undefined;
  }

  private extractiveSummary(transcript: string): string {
    const sentences = transcript
      .split(/(?<=[.!?])\s+|\n/)
      .map(s => s.trim())
      .filter(s => s.length > 10);
    return sentences.slice(0, 8).join(' ');
  }
}
