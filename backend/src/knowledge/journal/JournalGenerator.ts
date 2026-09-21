import * as fs from 'fs';
import * as path from 'path';
import { VectorMemory, UserActivity } from '../../core/memory/VectorMemory';
import { KnowledgeGraph } from '../KnowledgeGraph';
import { PrivacyGuard } from '../../core/privacy/PrivacyGuard';
import { getLogger } from '../../core/Logger';

export interface HourBlock {
  hour: number;
  label: string;
  apps: string[];
  urls: string[];
  contexts: string[];
  patterns: string[];
  screenContent: string;
  privacyBlocks: number;
  activityCount: number;
}

export interface DailyJournal {
  date: string;
  dayOfWeek: string;
  totalActiveMinutes: number;
  totalPrivacyBlocks: number;
  appsUsed: string[];
  contexts: string[];
  patternsFound: string[];
  hours: HourBlock[];
}

export class JournalGenerator {
  private memory: VectorMemory;
  private knowledge: KnowledgeGraph;
  private privacy: PrivacyGuard;
  private journalDir: string;
  private topicsDir: string;

  constructor(
    memory: VectorMemory,
    knowledge: KnowledgeGraph,
    privacy: PrivacyGuard,
    baseDir: string,
  ) {
    this.memory = memory;
    this.knowledge = knowledge;
    this.privacy = privacy;
    this.journalDir = path.join(baseDir, 'journal');
    this.topicsDir = path.join(baseDir, 'topics');
  }

  initialize(): void {
    if (!fs.existsSync(this.journalDir)) fs.mkdirSync(this.journalDir, { recursive: true });
    if (!fs.existsSync(this.topicsDir)) fs.mkdirSync(this.topicsDir, { recursive: true });
    getLogger().info('Journal generator initialized');
  }

  async generateDailyJournal(date?: Date): Promise<DailyJournal> {
    const targetDate = date || new Date();
    const dateStr = this.formatDate(targetDate);
    const dayOfWeek = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][targetDate.getDay()];

    const dayStart = new Date(targetDate);
    dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(targetDate);
    dayEnd.setHours(23, 59, 59, 999);

    const activities = this.memory.getUserActivity({ since: dayStart, limit: 5000 });

    if (activities.length === 0) {
      getLogger().info({ date: dateStr }, 'No activity for this date, skipping journal');
      return {
        date: dateStr, dayOfWeek, totalActiveMinutes: 0, totalPrivacyBlocks: 0,
        appsUsed: [], contexts: [], patternsFound: [], hours: [],
      };
    }

    const hours = this.buildHourBlocks(activities, targetDate);
    const appsUsed = [...new Set(activities.filter(a => !a.appName.startsWith('[PRIVATE]')).map(a => a.appName))];
    const contexts = [...new Set(activities.flatMap(a => (a.contextTags || '').split(',').map(t => t.trim()).filter(Boolean)))];
    const totalMinutes = Math.round(activities.reduce((s, a) => s + (a.durationSec || 0), 0) / 60);
    const totalPrivacy = activities.filter(a => a.appName.startsWith('[PRIVATE]')).length;
    const patterns = this.memory.getHighConfidencePatterns(2).map(p => p.suggestedKeyword || p.patternType).filter(Boolean);

    const journal: DailyJournal = {
      date: dateStr,
      dayOfWeek,
      totalActiveMinutes: totalMinutes,
      totalPrivacyBlocks: totalPrivacy,
      appsUsed,
      contexts,
      patternsFound: [...new Set(patterns)],
      hours,
    };

    await this.writeJournalFile(dateStr, journal);
    await this.updateJournalIndex(dateStr, journal);
    await this.updateTopicPages(journal);
    await this.createKnowledgeNodeFromJournal(journal);

    getLogger().info({ date: dateStr, hours: hours.length, apps: appsUsed.length }, 'Daily journal generated');

    return journal;
  }

  private buildHourBlocks(activities: UserActivity[], dateForOcr: Date): HourBlock[] {
    const hourMap = new Map<number, UserActivity[]>();

    for (const a of activities) {
      if (a.appName.startsWith('[PRIVATE]')) continue;
      const h = a.hourOfDay !== null && a.hourOfDay !== undefined ? a.hourOfDay : new Date(a.createdAt || Date.now()).getHours();
      if (!hourMap.has(h)) hourMap.set(h, []);
      hourMap.get(h)!.push(a);
    }

    const hours: HourBlock[] = [];

    for (let h = 0; h < 24; h++) {
      const acts = hourMap.get(h) || [];
      if (acts.length === 0) continue;

      const apps = [...new Set(acts.map(a => a.appName))];
      const urls = [...new Set(acts.map(a => a.targetUrl).filter(Boolean) as string[])];
      const contexts = [...new Set(acts.flatMap(a => (a.contextTags || '').split(',').map(t => t.trim()).filter(Boolean)))];
      const patterns = this.detectHourPatterns(acts);

      const screenContent = this.buildHourSummary(acts);

      const ocrText = this.memory.getHourlyScreenSummary(dateForOcr, h);

      const label = this.inferHourLabel(apps, contexts, patterns);

      hours.push({
        hour: h,
        label,
        apps,
        urls: urls.slice(0, 10),
        contexts: contexts.slice(0, 8),
        patterns,
        screenContent: ocrText || screenContent,
        privacyBlocks: acts.filter(a => a.appName.startsWith('[PRIVATE]')).length,
        activityCount: acts.length,
      });
    }

    return hours;
  }

  private inferHourLabel(apps: string[], contexts: string[], patterns: string[]): string {
    const ctx = contexts.map(c => c.toLowerCase());
    const app = apps.map(a => a.toLowerCase());

    if (ctx.some(c => c.includes('email') || c.includes('mail'))) return 'Email & Communication';
    if (ctx.some(c => c.includes('coding') || c.includes('development'))) {
      if (patterns.includes('debugging') || ctx.some(c => c.includes('debug'))) return 'Development â€” Debugging';
      if (patterns.includes('code_review')) return 'Development â€” Code Review';
      return 'Development';
    }
    if (ctx.some(c => c.includes('terminal') || c.includes('cli'))) return 'Terminal & CLI';
    if (ctx.some(c => c.includes('web') || c.includes('browsing'))) return 'Web Browsing & Research';
    if (ctx.some(c => c.includes('chat') || c.includes('communication'))) return 'Chat & Communication';
    if (ctx.some(c => c.includes('media') || c.includes('music'))) return 'Media & Entertainment';
    if (app.some(a => a.includes('meeting') || a.includes('zoom') || a.includes('teams'))) return 'Meetings';
    if (app.some(a => a.includes('word') || a.includes('excel') || a.includes('office'))) return 'Office Work';
    if (app.some(a => a.includes('figma') || a.includes('photoshop'))) return 'Design Work';

    return 'General Activity';
  }

  private detectHourPatterns(activities: UserActivity[]): string[] {
    const patterns: string[] = [];
    const allText = activities.map(a => `${a.contextTags} ${a.appName} ${a.windowTitle}`).join(' ').toLowerCase();

    if (/error|exception|failed|crash|timeout|bug/i.test(allText)) patterns.push('debugging');
    if (/pull request|merge|review|pr\s#/i.test(allText)) patterns.push('code_review');
    if (/search|find|look up|research/i.test(allText)) patterns.push('researching');
    if (/write|edit|modify|refactor|implement|code|develop/i.test(allText)) patterns.push('coding');
    if (/deploy|release|publish|ship|ci|cd/i.test(allText)) patterns.push('deploying');
    if (/plan|design|architect|proposal|doc/i.test(allText)) patterns.push('planning');
    if (/meeting|sync|standup|call|discuss|agenda/i.test(allText)) patterns.push('meeting');
    if (/learn|tutorial|guide|read|doc|study/i.test(allText)) patterns.push('learning');

    return [...new Set(patterns)];
  }

  private buildHourSummary(activities: UserActivity[]): string {
    const uniqueContexts = [...new Set(activities.flatMap(a => (a.contextTags || '').split(',').map(t => t.trim()).filter(Boolean)))];
    const topApps = this.getTopItems(activities.map(a => a.appName), 3);
    const urls = activities.map(a => a.targetUrl).filter(Boolean) as string[];

    let summary = `**Apps:** ${topApps.join(', ')}`;
    if (uniqueContexts.length > 0) summary += `\n**Context:** ${uniqueContexts.slice(0, 5).join(', ')}`;
    if (urls.length > 0) summary += `\n**URLs:** ${urls.slice(0, 5).join(', ')}`;
    summary += `\n**Keystrokes:** ${activities.reduce((s, a) => s + (a.keystrokeCount || 0), 0)}`;
    summary += `\n**Clicks:** ${activities.reduce((s, a) => s + (a.clickCount || 0), 0)}`;

    return summary;
  }

  private async writeJournalFile(dateStr: string, journal: DailyJournal): Promise<void> {
    const year = dateStr.substring(0, 4);
    const month = dateStr.substring(5, 7);
    const dir = path.join(this.journalDir, year, month);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const md = this.formatJournalMarkdown(journal);
    const filePath = path.join(dir, `${dateStr}.md`);
    fs.writeFileSync(filePath, md, 'utf-8');

    getLogger().info({ file: filePath }, 'Journal file written');
  }

  private formatJournalMarkdown(j: DailyJournal): string {
    const tags = ['journal', j.date, ...j.contexts.map(c => c.toLowerCase().replace(/[^a-z0-9]/g, '_'))];
    const links = ['journal', ...j.appsUsed.slice(0, 5).map(a => `learned/apps/${a.toLowerCase().replace(/[^a-z0-9]/g, '_')}`), ...j.contexts.slice(0, 3).map(c => `learned/contexts/${c.toLowerCase().replace(/[^a-z0-9]/g, '_')}`)];
    const frontmatter = `---
title: 'Journal: ${j.date}'
date: ${j.date}
tags: [${tags.map(t => `"${t}"`).join(', ')}]
links: [${links.map(l => `"${l}"`).join(', ')}]
category: system
---

`;

    const hoursMd = j.hours.map(h => {
      const timeStr = `${String(h.hour).padStart(2, '0')}:00 â€” ${String(h.hour).padStart(2, '0')}:59`;
      const appsList = h.apps.map(a => `  - ${a}`).join('\n');
      const urlsList = h.urls.map(u => `  - ${u}`).join('\n');
      const ctxList = h.contexts.map(c => `  - ${c}`).join('\n');
      const patternsList = h.patterns.map(p => `  - ${p}`).join('\n');

      const screenContentLines = h.screenContent.split('\n').map(l => `  ${l}`).join('\n');

      return `### ${timeStr} â€” ${h.label}

**Activity count:** ${h.activityCount}
**Apps:**
${appsList || '  - (none)'}
${h.urls.length > 0 ? `**URLs:**\n${urlsList}\n` : ''}
${h.contexts.length > 0 ? `**Contexts:**\n${ctxList}\n` : ''}
${h.patterns.length > 0 ? `**Patterns:**\n${patternsList}\n` : ''}
**Screen content:**
${screenContentLines || '  (no OCR data)'}

`;
    }).join('\n');

    const appsList = j.appsUsed.map(a => `  - ${a}`).join('\n');
    const ctxList = j.contexts.map(c => `  - ${c}`).join('\n');
    const patternsList = j.patternsFound.map(p => `  - ${p}`).join('\n');

    return `${frontmatter}# ${j.date} (${j.dayOfWeek})

## Overview
- **Active time:** ${Math.floor(j.totalActiveMinutes / 60)}h ${j.totalActiveMinutes % 60}m
- **Privacy blocks:** ${j.totalPrivacyBlocks}
- **Apps used:** ${j.appsUsed.length}
- **Contexts detected:** ${j.contexts.length}

## Apps Used
${appsList || '  - (none)'}

## Contexts
${ctxList || '  - (none)'}

## Patterns Detected
${patternsList || '  - (none)'}

---

## Hourly Breakdown

${hoursMd || '  - No significant activity detected.'}

---
*Auto-generated by Umbra OS Journal Generator.*
`;
  }

  private async updateJournalIndex(dateStr: string, journal: DailyJournal): Promise<void> {
    const indexPath = path.join(this.journalDir, 'index.md');

    let existingContent = '';
    if (fs.existsSync(indexPath)) {
      existingContent = fs.readFileSync(indexPath, 'utf-8');
    }

    const year = dateStr.substring(0, 4);
    const month = dateStr.substring(5, 7);

    const entryLine = `  - [[journal/${year}/${month}/${dateStr}|${dateStr}]] â€” ${Math.floor(journal.totalActiveMinutes / 60)}h ${journal.totalActiveMinutes % 60}m â€” ${journal.appsUsed.slice(0, 3).join(', ')}${journal.appsUsed.length > 3 ? '...' : ''}`;

    let newContent: string;

    if (!existingContent) {
      newContent = `# Activity Journal

A daily log of everything I've observed. Each note contains hourly breakdowns, apps used, contexts, and patterns.

## Navigation
- [[topics/index|Browse by Topic]]

## Entries

${entryLine}

---
*Auto-generated. Updated daily.*
`;
    } else {
      if (existingContent.includes(entryLine)) return;
      const insertPoint = existingContent.lastIndexOf('---');
      const header = insertPoint !== -1 ? existingContent.substring(0, insertPoint) : existingContent;
      newContent = `${header.trim()}\n${entryLine}\n\n---\n*Auto-generated. Updated daily.*\n`;
    }

    fs.writeFileSync(indexPath, newContent, 'utf-8');
  }

  private async updateTopicPages(journal: DailyJournal): Promise<void> {
    for (const context of journal.contexts) {
      if (!context) continue;
      const topicId = context.toLowerCase().replace(/[^a-z0-9]/g, '_');
      const topicPath = path.join(this.topicsDir, `${topicId}.md`);
      const dateLink = `[[journal/${journal.date.substring(0, 4)}/${journal.date.substring(5, 7)}/${journal.date}|${journal.date}]]`;

      let existing = '';
      if (fs.existsSync(topicPath)) {
        existing = fs.readFileSync(topicPath, 'utf-8');
      }

      if (existing.includes(dateLink)) continue;

      const entryLine = `  - ${dateLink} â€” ${Math.floor(journal.totalActiveMinutes / 60)}h ${journal.totalActiveMinutes % 60}m`;

      const newContent = existing
        ? `${existing.trim()}\n${entryLine}\n`
        : `# Topic: ${context}\n\nA collection of journal entries related to ${context}.\n\n## Entries\n${entryLine}\n\n---\n*Auto-generated.*\n`;

      fs.writeFileSync(topicPath, newContent, 'utf-8');
    }
  }

  private async createKnowledgeNodeFromJournal(journal: DailyJournal): Promise<void> {
    if (journal.hours.length === 0) return;

    const dateStr = journal.date;
    const content = `# Journal: ${dateStr} (${journal.dayOfWeek})\n\n## Overview\n- Active: ${Math.floor(journal.totalActiveMinutes / 60)}h ${journal.totalActiveMinutes % 60}m\n- Apps: ${journal.appsUsed.join(', ')}\n- Contexts: ${journal.contexts.join(', ')}\n- Privacy blocks: ${journal.totalPrivacyBlocks}\n\n## Hours\n${journal.hours.map(h => `- **${String(h.hour).padStart(2, '0')}:00** â€” ${h.label} (${h.apps.slice(0, 3).join(', ')})`).join('\n')}\n\n## Patterns\n${journal.patternsFound.map(p => `- ${p}`).join('\n')}`;

    await this.knowledge.addOrUpdate(
      `journal/${dateStr}`,
      `Journal: ${dateStr}`,
      content,
      ['journal', dateStr, ...journal.contexts.map(c => c.toLowerCase().replace(/[^a-z0-9]/g, '_')), ...journal.patternsFound],
      ['journal', dateStr, ...journal.contexts.slice(0, 3)],
      'system',
    );
  }

  async findInJournals(query: string, dateStr?: string): Promise<string[]> {
    const results: string[] = [];

    if (dateStr) {
      const year = dateStr.substring(0, 4);
      const month = dateStr.substring(5, 7);
      const filePath = path.join(this.journalDir, year, month, `${dateStr}.md`);
      if (fs.existsSync(filePath)) {
        const content = fs.readFileSync(filePath, 'utf-8');
        const q = query.toLowerCase();
        const lines = content.split('\n').filter(l => l.toLowerCase().includes(q));
        if (lines.length > 0) {
          results.push(`## ${dateStr}`);
          results.push(...lines.slice(0, 10));
        }
      }
    } else {
      const allJournals = this.findAllJournalFiles();
      for (const filePath of allJournals) {
        const content = fs.readFileSync(filePath, 'utf-8');
        if (content.toLowerCase().includes(query.toLowerCase())) {
          const relPath = path.relative(this.journalDir, filePath);
          const lines = content.split('\n').filter(l => l.toLowerCase().includes(query.toLowerCase()));
          results.push(`## ${relPath.replace(/\.md$/, '')}`);
          results.push(...lines.slice(0, 5));
        }
      }
    }

    return results;
  }

  async queryAgent(question: string): Promise<string> {
    const q = question.toLowerCase();

    const datePatterns = [
      { regex: /yesterday/, offset: -1 },
      { regex: /today/, offset: 0 },
      { regex: /this week/, offset: -7 },
      { regex: /last (\d+) days/, offset: (m: RegExpExecArray) => -parseInt(m[1]) },
    ];

    let targetDate: Date | null = null;

    for (const { regex, offset } of datePatterns) {
      const match = regex.exec(q);
      if (match) {
        const days = typeof offset === 'function' ? offset(match) : offset;
        targetDate = new Date();
        targetDate.setDate(targetDate.getDate() + days);
        break;
      }
    }

    const timePattern = q.match(/(\d{1,2})\s*(?::(\d{2}))?\s*(am|pm)/i);
    let targetHour: number | null = null;
    if (timePattern) {
      let h = parseInt(timePattern[1]);
      const meridiem = timePattern[3]?.toLowerCase();
      if (meridiem === 'pm' && h < 12) h += 12;
      if (meridiem === 'am' && h === 12) h = 0;
      targetHour = h;
    }

    if (targetDate) {
      const dateStr = this.formatDate(targetDate);
      const journal = await this.findInJournals('', dateStr);
      if (journal.length > 0) {
        let result = journal.join('\n');
        if (targetHour !== null) {
          const hourStr = String(targetHour).padStart(2, '0');
          const hourBlock = result.split('\n').filter((l, i, a) => {
            return l.includes(`${hourStr}:00`) || (i > 0 && a[i - 1].includes(`${hourStr}:00`));
          }).join('\n');
          if (hourBlock) result = hourBlock;
        }

        if (q.includes('email') || q.includes('mail')) {
          result = result.split('\n').filter((l, i, a) => {
            const curr = l.toLowerCase();
            const prev = i > 0 ? a[i - 1].toLowerCase() : '';
            return curr.includes('email') || curr.includes('mail') || curr.includes('outlook') || prev.includes('email') || prev.includes('mail');
          }).join('\n');
        }

        return result || `Found the journal for ${dateStr} but no specific match for your question.`;
      }
      return `No journal found for ${dateStr}.`;
    }

    const allMatches = await this.findInJournals(question);
    return allMatches.length > 0
      ? allMatches.join('\n')
      : `I couldn't find anything matching "${question}" in the journals. Try browsing [[journal/index|the journal index]].`;
  }

  private findAllJournalFiles(): string[] {
    const files: string[] = [];
    this.walkDir(this.journalDir, files);
    return files.filter(f => f.endsWith('.md') && !f.endsWith('index.md'));
  }

  private walkDir(dir: string, results: string[]): void {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) this.walkDir(full, results);
        else if (e.name.endsWith('.md')) results.push(full);
      }
    } catch { }
  }

  private getTopItems(items: string[], n: number): string[] {
    const counts = new Map<string, number>();
    for (const item of items) {
      if (item.startsWith('[PRIVATE]')) continue;
      counts.set(item, (counts.get(item) || 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([item]) => item);
  }

  private formatDate(d: Date): string {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
}
