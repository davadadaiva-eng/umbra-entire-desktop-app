import * as fs from 'fs';
import * as path from 'path';

export interface PersistedMeeting {
  id: string;
  url: string;
  title?: string;
  startedAt: string;
  endedAt: string;
  attendees: string[];
  transcript: Array<{ speaker: string; text: string; atMs: number }>;
  summary: string;
  actionItems: string[];
  decisions: string[];
  recordingPath?: string;
}

export class MeetingStore {
  private dir: string;

  constructor(dataDir: string) {
    this.dir = path.join(dataDir, 'meetings');
    if (!fs.existsSync(this.dir)) fs.mkdirSync(this.dir, { recursive: true });
  }

  save(meeting: PersistedMeeting): void {
    const p = path.join(this.dir, `${meeting.id}.json`);
    fs.writeFileSync(p, JSON.stringify(meeting, null, 2), 'utf-8');
  }

  get(id: string): PersistedMeeting | null {
    const p = path.join(this.dir, `${id}.json`);
    if (!fs.existsSync(p)) return null;
    try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; }
  }

  list(limit: number = 20): PersistedMeeting[] {
    if (!fs.existsSync(this.dir)) return [];
    const files = fs.readdirSync(this.dir).filter(f => f.endsWith('.json')).sort().reverse().slice(0, limit);
    const out: PersistedMeeting[] = [];
    for (const f of files) {
      try { out.push(JSON.parse(fs.readFileSync(path.join(this.dir, f), 'utf-8'))); } catch {}
    }
    return out;
  }

  delete(id: string): boolean {
    const p = path.join(this.dir, `${id}.json`);
    if (!fs.existsSync(p)) return false;
    fs.unlinkSync(p);
    return true;
  }
}
