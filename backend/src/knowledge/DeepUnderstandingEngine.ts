import { VectorMemory } from '../core/memory/VectorMemory';
import { KnowledgeGraph } from './KnowledgeGraph';
import { LLMConnector, LLMMessage } from '../core/agent/LLMConnector';
import { getLogger } from '../core/Logger';
import { extractJson } from '../core/utils/extractJson';

interface ActivitySegment {
  timeStart: string;
  timeEnd: string;
  appName: string;
  url?: string;
  topic: string;
  summary: string;
  rawTexts: string[];
  snapshotCount: number;
}

export class DeepUnderstandingEngine {
  private memory: VectorMemory;
  private knowledge: KnowledgeGraph;
  private llm?: LLMConnector;
  private lastRunTime: number = 0;
  private runIntervalMs: number = 120000;

  constructor(memory: VectorMemory, knowledge: KnowledgeGraph) {
    this.memory = memory;
    this.knowledge = knowledge;
  }

  setLLM(llm: LLMConnector): void {
    this.llm = llm;
  }

  setInterval(ms: number): void {
    this.runIntervalMs = ms;
  }

  async processRecentActivity(): Promise<{ segments: number; nodesCreated: number }> {
    if (!this.llm) return { segments: 0, nodesCreated: 0 };

    const since = new Date(this.lastRunTime || Date.now() - 300000);
    this.lastRunTime = Date.now();

    const snapshots = this.memory.getScreenSnapshots({ since, limit: 100 });
    if (snapshots.length < 3) return { segments: 0, nodesCreated: 0 };

    const segments = this.segmentByTopic(snapshots);
    let nodesCreated = 0;

    for (const segment of segments) {
      if (segment.rawTexts.join(' ').trim().length < 50) continue;
      try {
        const created = await this.expandAndWrite(segment);
        if (created) nodesCreated++;
      } catch (err: any) {
        getLogger().debug({ err: err.message, topic: segment.topic }, 'Deep understanding failed');
      }
    }

    if (segments.length >= 2) {
      try {
        await this.writeSessionBreakdown(segments);
        nodesCreated++;
      } catch {}
    }

    getLogger().info({ segments: segments.length, nodesCreated }, 'Deep understanding cycle complete');
    return { segments: segments.length, nodesCreated };
  }

  private segmentByTopic(snapshots: any[]): ActivitySegment[] {
    const segments: ActivitySegment[] = [];
    let current: ActivitySegment | null = null;

    for (const snap of snapshots) {
      const text = (snap.filteredText || '').trim();
      const app = snap.appName || 'unknown';
      const time = snap.createdAt ? new Date(snap.createdAt).toISOString() : '';
      const url = this.extractUrl(text);

      const topicKey = this.inferTopic(text, app, url);

      if (!current || current.topic !== topicKey) {
        if (current) segments.push(current);
        current = {
          timeStart: time,
          timeEnd: time,
          appName: app,
          url,
          topic: topicKey,
          summary: '',
          rawTexts: text ? [text] : [],
          snapshotCount: 1,
        };
      } else {
        current.timeEnd = time;
        if (text) current.rawTexts.push(text);
        current.snapshotCount++;
        current.url = current.url || url;
        if (!current.appName || current.appName === 'screen') current.appName = app;
      }
    }
    if (current) segments.push(current);

    return segments;
  }

  private inferTopic(text: string, app: string, url?: string): string {
    const lower = text.toLowerCase();
    const urlHost = url ? this.extractHost(url) : '';

    if (urlHost && urlHost !== 'google.com' && urlHost !== 'search.google.com') {
      return urlHost.replace(/^www\./, '').split('.')[0];
    }
    if (url && url.includes('search')) {
      const qMatch = url.match(/[?&]q=([^&]+)/);
      if (qMatch) return decodeURIComponent(qMatch[1]).substring(0, 40);
    }
    if (/github|gitlab|bitbucket/.test(lower)) return 'coding_review';
    if (/vscode|cursor|code|editor|ide/.test(lower)) return 'coding';
    if (/terminal|powershell|cmd|bash|shell|npm |npx |git |docker/.test(lower)) return 'terminal';
    if (/youtube|video|watch/.test(lower)) return 'video';
    if (/instagram|social|facebook|reddit|twitter/.test(lower)) return 'social_media';
    if (/gmail|outlook|mail/.test(lower)) return 'email';
    if (app && app !== 'screen' && app !== 'unknown') return app.toLowerCase().replace(/[^a-z0-9]/g, '_');
    if (lower.length > 20) return lower.split(/[^a-z]/).filter(w => w.length > 3).slice(0, 3).join('_');
    return 'general_activity';
  }

  private extractUrl(text: string): string | undefined {
    const m = text.match(/https?:\/\/[^\s)"]+/);
    return m ? m[0] : undefined;
  }

  private extractHost(url: string): string {
    try { return new URL(url).hostname; } catch { return ''; }
  }

  private async expandAndWrite(segment: ActivitySegment): Promise<boolean> {
    if (!this.llm) return false;

    const combinedText = segment.rawTexts.join('\n\n').substring(0, 4000);
    const topicSlug = segment.topic.replace(/[^a-z0-9_]/gi, '_').toLowerCase().substring(0, 50);

    const nodeId = `learned/topics/${topicSlug}`;
    const existing = await this.knowledge.getNode(nodeId);
    if (existing) return false;

    const messages: LLMMessage[] = [
      {
        role: 'system',
        content: `You are the research-and-expand brain of Umbra OS. Given screen observations of what the user was looking at, you must:

1. Identify exactly what topic/resource the user was engaging with
2. If it's a tool, product, or service (e.g. "Freebuff"): explain what it is, what it does, key features
3. If it's a project or code: describe the architecture, key files, patterns
4. Write in clear, well-structured plain English

Respond with a JSON object:
{
  "title": "Short descriptive title",
  "summary": "2-3 sentence plain English summary of what the user was doing",
  "expandedContent": "Detailed markdown content (200-800 words, ### sections, bullet points, code blocks)",
  "tags": ["tag1", "tag2", "tag3"],
  "urlsReferenced": ["url1"]
}

The expandedContent becomes a knowledge node. Write it like you're documenting what Umbra OS learned — be thorough, accurate, and specific.`,
      },
      {
        role: 'user',
        content: `Screen observations from ${segment.timeStart} to ${segment.timeEnd}:\nApp: ${segment.appName}\nURL: ${segment.url || '(none)'}\n\nOCR text captured:\n${combinedText}`,
      },
    ];

    const result = await this.llm.complete(messages, 'fast', { temperature: 0.3, maxTokens: 2048 });
    const parsed = extractJson(result.content);
    if (!parsed) return false;
    const tags = ['learned', 'deep_understanding', ...(parsed.tags || []), segment.appName.toLowerCase()];

    await this.knowledge.addOrUpdate(
      nodeId,
      parsed.title || `Topic: ${segment.topic}`,
      parsed.expandedContent || parsed.summary || combinedText.substring(0, 500),
      tags,
      ['index', 'learned/topics'],
      'domain',
    );

    getLogger().info({ nodeId, title: parsed.title }, 'Deep understanding: created knowledge node');
    return true;
  }

  private async writeSessionBreakdown(segments: ActivitySegment[]): Promise<void> {
    if (!this.llm) return;

    const summary = segments.map((s, i) =>
      `${i + 1}. [${s.timeStart.substring(11, 19)}-${s.timeEnd.substring(11, 19)}] ${s.appName}${s.url ? ' (' + s.url + ')' : ''} — ${s.snapshotCount} captures`
    ).join('\n');

    const allText = segments.map(s => s.rawTexts.join(' ').substring(0, 500)).join('\n\n').substring(0, 3000);

    const messages: LLMMessage[] = [
      {
        role: 'system',
        content: `Write a comprehensive plain-English breakdown of what the user did in this session. Structure it as:

# Session Breakdown: {date}

## Overview
2-3 sentences summarizing the session

## Timeline
### {time range} — {activity title}
What they did, what tools they used, what they were researching/working on.

## Key Topics Encountered
- Topic: description

## What Umbra Learned
Key insights, tools discovered, projects worked on.

Write in natural, narrative English. 300-800 words.`,
      },
      {
        role: 'user',
        content: `Session timeline:\n${summary}\n\nScreen observations:\n${allText}`,
      },
    ];

    const result = await this.llm.complete(messages, 'fast', { temperature: 0.3, maxTokens: 2048 });

    const date = new Date().toISOString().substring(0, 10);
    await this.knowledge.addOrUpdate(
      `learned/sessions/session-${date}`,
      `Session Breakdown: ${date}`,
      result.content,
      ['learned', 'session', 'deep_understanding', 'breakdown'],
      ['index', 'learned/sessions'],
      'system',
    );

    getLogger().info('Deep understanding: wrote session breakdown');
  }
}
