import { VectorMemory } from '../memory/VectorMemory';
import { KnowledgeGraph } from '../../knowledge/KnowledgeGraph';
import { ActivityWatcher } from '../recall/ActivityWatcher';
import { AgentRuntime } from './AgentRuntime';
import { LLMConnector, LLMMessage } from './LLMConnector';
import { RecallToKnowledgeBridge } from '../../knowledge/RecallToKnowledgeBridge';
import { DeepUnderstandingEngine } from '../../knowledge/DeepUnderstandingEngine';
import { eventBus } from '../EventBus';
import { getLogger } from '../Logger';
import { extractJson } from '../utils/extractJson';

export interface ProactiveSuggestion {
  type: 'automate' | 'remind' | 'optimize' | 'learn' | 'inform';
  title: string;
  description: string;
  confidence: number;
  action?: string;
  sourcePattern?: string;
}

export class ProactiveAgent {
  private memory: VectorMemory;
  private knowledge: KnowledgeGraph;
  private watcher: ActivityWatcher;
  private bridge: RecallToKnowledgeBridge;
  private deepEngine: DeepUnderstandingEngine;
  private agent?: AgentRuntime;
  private llm?: LLMConnector;

  private timer: NodeJS.Timeout | null = null;
  private enabled: boolean = false;
  private checkIntervalMs: number = 30000;
  private lastKnownApp: string = '';
  private lastSuggestionTime: number = 0;
  private cooldownMs: number = 60000;

  constructor(
    memory: VectorMemory,
    knowledge: KnowledgeGraph,
    watcher: ActivityWatcher,
    bridge: RecallToKnowledgeBridge,
    deepEngine: DeepUnderstandingEngine,
  ) {
    this.memory = memory;
    this.knowledge = knowledge;
    this.watcher = watcher;
    this.bridge = bridge;
    this.deepEngine = deepEngine;
  }

  setAgent(agent: AgentRuntime): void {
    this.agent = agent;
  }

  setLLM(llm: LLMConnector): void {
    this.llm = llm;
    this.deepEngine.setLLM(llm);
  }

  start(): void {
    if (this.enabled) return;
    this.enabled = true;

    this.timer = setInterval(() => this.proactiveCheck(), this.checkIntervalMs);
    getLogger().info({ interval: this.checkIntervalMs }, 'Proactive agent started');
  }

  stop(): void {
    this.enabled = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    getLogger().info('Proactive agent stopped');
  }

  private async proactiveCheck(): Promise<void> {
    if (!this.enabled) return;
    const now = Date.now();
    if (now - this.lastSuggestionTime < this.cooldownMs) return;

    try {
      const context = this.memory.getUserActivityPatterns(15);
      if (context.appSequence.length === 0) return;

      const suggestions = await this.generateSuggestions(context);

      if (suggestions.length > 0 && suggestions[0].confidence >= 70) {
        const top = suggestions[0];
        this.lastSuggestionTime = now;

        getLogger().info({
          type: top.type,
          title: top.title,
          confidence: top.confidence,
          sourcePattern: top.sourcePattern,
        }, 'Proactive suggestion');

        if (top.type === 'automate' && top.confidence >= 85) {
          await this.autoExecute(top);
        }
      }

      await this.checkKnowledgeGaps();
      await this.deepEngine.processRecentActivity();
      await this.watcher.analyzePatterns();

    } catch (err: any) {
      getLogger().debug({ err: err.message }, 'Proactive check error');
    }
  }

  private async generateSuggestions(context: {
    appSequence: string[];
    topApps: string[];
    currentContext: string;
  }): Promise<ProactiveSuggestion[]> {
    const suggestions: ProactiveSuggestion[] = [];

    // Learn from repeated app sequences
    const highFreqPatterns = this.memory.getHighConfidencePatterns(3);
    for (const pattern of highFreqPatterns.slice(0, 3)) {
      const appSequence = context.appSequence.join(' -> ');
      if (appSequence.includes(pattern.patternJson.substring(0, 30))) {
        suggestions.push({
          type: 'automate',
          title: pattern.suggestedKeyword || 'Repeated workflow detected',
          description: `I've seen you do this ${pattern.frequency} times. Want me to automate it?`,
          confidence: Math.min(90, 50 + pattern.frequency * 10),
          action: pattern.suggestedKeyword || undefined,
          sourcePattern: pattern.patternJson,
        });
      }
    }

    // Suggest unread patterns from history
    const recentActivity = this.memory.getUserActivity({ since: new Date(Date.now() - 3600000), limit: 50 });
    if (recentActivity.length >= 20 && context.currentContext) {
      const relevantKnowledge = await this.knowledge.search(context.currentContext);
      if (relevantKnowledge.length > 0) {
        suggestions.push({
          type: 'inform',
          title: `Working on ${context.currentContext}?`,
          description: `I have ${relevantKnowledge.length} relevant knowledge nodes. Shall I use them?`,
          confidence: 65,
          action: undefined,
          sourcePattern: context.currentContext,
        });
      }
    }

    if (this.llm && context.appSequence.length >= 5) {
      try {
        const aiSuggestions = await this.aiSuggest(context);
        suggestions.push(...aiSuggestions);
      } catch { }
    }

    return suggestions.sort((a, b) => b.confidence - a.confidence);
  }

  private async aiSuggest(context: {
    appSequence: string[];
    topApps: string[];
    currentContext: string;
  }): Promise<ProactiveSuggestion[]> {
    if (!this.llm) return [];

    const recentActivity = this.memory.getUserActivity({ limit: 30 });
    const recentSummary = recentActivity.map(a => `[${a.appName}] ${a.action} â€” ${a.contextTags}`).join('\n');
    const knownPatterns = this.memory.getHighConfidencePatterns(2);
    const patternSummary = knownPatterns.map(p => `  - "${p.suggestedKeyword || 'unnamed'}" (${p.frequency}x, ${Math.round(p.confidence * 100)}%)`).join('\n');

    const messages: LLMMessage[] = [
      {
        role: 'system',
        content: `You are Umbra OS's proactive brain. Analyze the user's recent activity and suggest helpful automations.

Only suggest things that are genuinely useful. Be conservative.

Respond with JSON array:
[{type: "automate|remind|optimize|learn|inform", title: "...", description: "...", confidence: 0-100, action: "/command"}]`,
      },
      {
        role: 'user',
        content: `Recent activity:\n${recentSummary}\n\nApp sequence: ${context.appSequence.join(' -> ')}\nTop apps: ${context.topApps.join(', ')}\nContext: ${context.currentContext}\n\nKnown patterns:\n${patternSummary || '  (none yet)'}`,
      },
    ];

    const result = await this.llm.complete(messages, 'fast', { temperature: 0.3 });
    try {
      const parsed = extractJson(result.content);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  private async autoExecute(suggestion: ProactiveSuggestion): Promise<void> {
    if (!this.agent || !suggestion.action) return;
    getLogger().info({ action: suggestion.action, title: suggestion.title }, 'Auto-executing proactive task');

    const task = await this.agent.submitTask(suggestion.description, 0);
    eventBus.emit('task:created', task.id);
  }

  private async checkKnowledgeGaps(): Promise<void> {
    try {
      const result = await this.bridge.ingestSince();
      if (result.nodesCreated > 0) {
        getLogger().info(result, 'Knowledge graph updated from recall bridge');
      }
    } catch (err: any) {
      getLogger().debug({ err: err.message }, 'Knowledge gap check error');
    }
  }
}
