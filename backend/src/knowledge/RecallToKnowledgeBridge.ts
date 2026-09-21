import { VectorMemory, UserActivity, PatternSummary } from '../core/memory/VectorMemory';
import { KnowledgeGraph } from './KnowledgeGraph';
import { LLMConnector } from '../core/agent/LLMConnector';
import { getLogger } from '../core/Logger';

export class RecallToKnowledgeBridge {
  private memory: VectorMemory;
  private knowledge: KnowledgeGraph;
  private llm?: LLMConnector;
  private lastIngestionTime: number = 0;
  private ingestIntervalMs: number = 60000;

  constructor(memory: VectorMemory, knowledge: KnowledgeGraph) {
    this.memory = memory;
    this.knowledge = knowledge;
  }

  setLLM(llm: LLMConnector): void {
    this.llm = llm;
  }

  async ingestSince(since?: Date): Promise<{ activitiesIngested: number; patternsFound: number; nodesCreated: number }> {
    const startTime = since || new Date(this.lastIngestionTime);
    this.lastIngestionTime = Date.now();

    getLogger().info({ since: startTime.toISOString() }, 'Ingesting user activity into knowledge graph');

    const recentActivity = this.memory.getUserActivity({ since: startTime, limit: 200 });
    if (recentActivity.length === 0) {
      return { activitiesIngested: 0, patternsFound: 0, nodesCreated: 0 };
    }

    let patternsFound = 0;
    let nodesCreated = 0;

    const appGroups = this.groupByApp(recentActivity);
    for (const [app, activities] of appGroups.entries()) {
      if (activities.length >= 5) {
        const created = await this.ensureAppKnowledgeNode(app, activities);
        if (created) nodesCreated++;
      }
    }

    const patterns = this.memory.getHighConfidencePatterns(2);
    for (const pattern of patterns) {
      if (!pattern.knowledgeNodeId) {
        const linked = await this.linkPatternToKnowledge(pattern);
        if (linked) {
          patternsFound++;
          nodesCreated++;
        }
      }
    }

    const topContexts = this.extractTopContexts(recentActivity);
    for (const [context, apps] of topContexts.entries()) {
      if (context && apps.length >= 2) {
        const existing = await this.knowledge.search(context);
        const hasExact = existing.some(n => n.tags.includes(context));
        if (!hasExact) {
          const nodeId = `learned/context-${context}`;
          const appList = apps.map(a => `  - ${a}`).join('\n');
          await this.knowledge.addOrUpdate(
            nodeId,
            `Context: ${context}`,
            `# ${context}\n\nWhen you see the user working in these apps, the context is "${context}":\n${appList}\n\n*Auto-generated from activity pattern.*`,
            [context, 'learned', 'context'],
            ['index', 'learned/contexts'],
            'domain',
          );
          nodesCreated++;
        }
      }
    }

    return { activitiesIngested: recentActivity.length, patternsFound, nodesCreated };
  }

  private groupByApp(activities: UserActivity[]): Map<string, UserActivity[]> {
    const groups = new Map<string, UserActivity[]>();
    for (const a of activities) {
      const key = a.appName.toLowerCase().replace(/[^a-z0-9]/g, '_');
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(a);
    }
    return groups;
  }

  private async ensureAppKnowledgeNode(appKey: string, activities: UserActivity[]): Promise<boolean> {
    const nodeId = `learned/apps/${appKey}`;
    const existing = await this.knowledge.getNode(nodeId);
    if (existing) return false;

    const firstActivity = activities[0];
    const commonActions = this.getCommonActions(activities);
    const peakHours = this.getPeakHours(activities);
    const totalDuration = activities.reduce((s, a) => s + (a.durationSec || 0), 0);

    let content = `# App: ${firstActivity.appName}\n\n## Usage Pattern\n- Total observations: ${activities.length}\n- Total active time: ${Math.round(totalDuration / 60)} minutes\n- Peak hours: ${peakHours.join(', ')}\n- Common actions: ${commonActions.join(', ')}\n\n## What this app is used for\n${this.inferAppPurpose(firstActivity.appName, commonActions, activities)}\n\n## How to automate\nWhen the user is in ${firstActivity.appName}, consider:\n`;

    if (firstActivity.appName.toLowerCase().includes('code') || firstActivity.appName.toLowerCase().includes('studio') || firstActivity.appName.toLowerCase().includes('cursor')) {
      content += `- Looking at open files to understand current context\n- Running tests or builds\n- Checking for errors in the terminal\n`;
    } else if (firstActivity.appName.toLowerCase().includes('chrome') || firstActivity.appName.toLowerCase().includes('firefox') || firstActivity.appName.toLowerCase().includes('edge')) {
      content += `- Checking which URLs are open for research context\n- Scraping information from active pages\n- Filling out forms\n`;
    } else {
      content += `- Monitoring for repetitive tasks in this app\n- Learning the user's workflow patterns\n`;
    }

    content += `\n*Auto-generated from activity tracking.*`;

    await this.knowledge.addOrUpdate(
      nodeId,
      `App: ${firstActivity.appName}`,
      content,
      [appKey, 'learned', 'app', ...commonActions.map(a => `action:${a}`)],
      ['index', 'learned/apps'],
      'domain',
    );

    getLogger().info({ nodeId, app: firstActivity.appName }, 'Created app knowledge node from user activity');
    return true;
  }

  private async linkPatternToKnowledge(pattern: PatternSummary): Promise<boolean> {
    const nodeId = `learned/patterns/${pattern.patternType}-${Date.now()}`;

    await this.knowledge.addOrUpdate(
      nodeId,
      `Pattern: ${pattern.suggestedKeyword || pattern.patternType}`,
      `# Pattern: ${pattern.suggestedKeyword || pattern.patternType}\n\n## Description\n${pattern.patternJson}\n\n## Frequency\n${pattern.frequency} times (confidence: ${Math.round(pattern.confidence * 100)}%)\n\n## Suggested Trigger\n\`/${pattern.suggestedKeyword || 'unknown'}\`\n\n*Auto-generated from repeated user behavior.*`,
      [pattern.patternType, 'learned', 'pattern', pattern.suggestedKeyword || ''].filter(Boolean),
      ['index', 'learned/patterns'],
      'workflow',
    );

    this.memory.linkPatternToKnowledge(pattern.patternId!, nodeId);
    return true;
  }

  private getCommonActions(activities: UserActivity[]): string[] {
    const actionCounts = new Map<string, number>();
    for (const a of activities) {
      if (a.action) {
        actionCounts.set(a.action, (actionCounts.get(a.action) || 0) + 1);
      }
    }
    return [...actionCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([action]) => action);
  }

  private getPeakHours(activities: UserActivity[]): string[] {
    const hourCounts = new Map<number, number>();
    for (const a of activities) {
      if (a.hourOfDay !== null && a.hourOfDay !== undefined) {
        hourCounts.set(a.hourOfDay, (hourCounts.get(a.hourOfDay) || 0) + 1);
      }
    }
    return [...hourCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([hour]) => `${hour}:00`);
  }

  private extractTopContexts(activities: UserActivity[]): Map<string, string[]> {
    const contextMap = new Map<string, Set<string>>();
    for (const a of activities) {
      const tags = (a.contextTags || '').split(',').map(t => t.trim()).filter(Boolean);
      for (const tag of tags) {
        if (!contextMap.has(tag)) contextMap.set(tag, new Set());
        contextMap.get(tag)!.add(a.appName);
      }
    }

    const result = new Map<string, string[]>();
    for (const [tag, apps] of contextMap.entries()) {
      if (apps.size >= 2) {
        result.set(tag, [...apps]);
      }
    }
    return result;
  }

  private inferAppPurpose(appName: string, _actions: string[], _activities: UserActivity[]): string {
    const low = appName.toLowerCase();
    if (low.includes('code') || low.includes('studio') || low.includes('cursor') || low.includes('sublime')) return 'Code editing and development';
    if (low.includes('chrome') || low.includes('firefox') || low.includes('edge') || low.includes('brave') || low.includes('safari')) return 'Web browsing and online research';
    if (low.includes('terminal') || low.includes('cmd') || low.includes('powershell')) return 'Command-line operations and scripting';
    if (low.includes('slack') || low.includes('discord') || low.includes('teams') || low.includes('zoom')) return 'Communication and collaboration';
    if (low.includes('outlook') || low.includes('thunderbird') || low.includes('mail')) return 'Email communication';
    if (low.includes('spotify') || low.includes('music')) return 'Media and entertainment';
    if (low.includes('explorer') || low.includes('finder')) return 'File management and navigation';
    if (low.includes('word') || low.includes('excel') || low.includes('powerpoint') || low.includes('office')) return 'Document creation and office work';
    if (low.includes('figma') || low.includes('photoshop') || low.includes('illustrator')) return 'Design and creative work';
    return 'General desktop activity';
  }
}
