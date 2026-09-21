import { VectorMemory, MacroStep, MacroDefinition } from '../memory/VectorMemory';
import { LLMConnector, LLMMessage } from '../agent/LLMConnector';
import { AgentRuntime } from '../agent/AgentRuntime';
import { getLogger } from '../Logger';

export class MacroSynthesizer {
  private recall: VectorMemory;
  private llm?: LLMConnector;
  private agent?: AgentRuntime;

  constructor(recall: VectorMemory) {
    this.recall = recall;
  }

  setLLM(llm: LLMConnector): void {
    this.llm = llm;
  }

  setAgent(agent: AgentRuntime): void {
    this.agent = agent;
  }

  async analyzePatterns(): Promise<void> {
    getLogger().info('Analyzing activity patterns for macro synthesis');
    const patterns = this.recall.findPatterns(5);
    const REPEAT_THRESHOLD = 3;

    for (const [pattern, count] of patterns.entries()) {
      if (count >= REPEAT_THRESHOLD) {
        getLogger().info({ pattern, count }, 'Frequent pattern detected');
        await this.synthesizeMacro(pattern, count);
      }
    }
  }

  private async synthesizeMacro(pattern: string, frequency: number): Promise<void> {
    const keyword = this.generateKeyword(pattern);
    const steps = this.patternToSteps(pattern);

    const macro: Omit<MacroDefinition, 'macroId' | 'createdAt'> = {
      triggerKeyword: keyword,
      detectedPattern: pattern,
      steps,
      executionCount: frequency,
    };

    this.recall.saveMacro(macro);
    getLogger().info({ keyword, pattern, stepCount: steps.length }, 'Macro synthesized from pattern');
  }

  async executeMacro(keyword: string, _userParams?: Record<string, unknown>): Promise<void> {
    const macro = this.recall.getMacro(keyword);
    if (!macro) throw new Error(`Macro "${keyword}" not found`);

    getLogger().info({ keyword, stepCount: macro.steps.length }, 'Executing macro');

    const taskDescription = `Execute macro "${keyword}": ${macro.detectedPattern}`;
    if (this.agent) {
      await this.agent.submitTask(taskDescription);
    }

    this.recall.saveMacro({
      ...macro,
      triggerKeyword: keyword,
      executionCount: macro.executionCount + 1,
    });
  }

  async intelligentlySuggestMacros(): Promise<{ keyword: string; description: string; confidence: number }[]> {
    const macros = this.recall.getAllMacros();
    const recentActivity = this.recall.getRecentActivity(20);

    const suggestions: { keyword: string; description: string; confidence: number }[] = macros.map(m => ({
      keyword: m.triggerKeyword,
      description: m.detectedPattern,
      confidence: Math.min(100, m.executionCount * 20),
    }));

    if (this.llm && recentActivity.length >= 5) {
      try {
        const activitySummary = recentActivity.map(a => `[${a.status}] ${a.description}`).join('\n');
        const messages: LLMMessage[] = [
          {
            role: 'system',
            content: 'Suggest macros based on recent activity. Respond with JSON array: [{keyword: string, description: string, confidence: number}]',
          },
          { role: 'user', content: activitySummary },
        ];

        const result = await this.llm.complete(messages, 'fast', { temperature: 0.3 });
        try {
          const aiSuggestions = JSON.parse(result.content);
          if (Array.isArray(aiSuggestions)) {
            suggestions.push(...aiSuggestions);
          }
        } catch { }
      } catch { }
    }

    return suggestions.sort((a, b) => b.confidence - a.confidence).slice(0, 10);
  }

  private generateKeyword(pattern: string): string {
    const parts = pattern.split(' -> ').filter(Boolean);
    const first = parts[0]?.substring(0, 10) || 'macro';
    const last = parts[parts.length - 1]?.substring(0, 10) || 'end';
    return `${first}_to_${last}`.toLowerCase().replace(/[^a-z0-9_]/g, '_').substring(0, 50);
  }

  private patternToSteps(pattern: string): MacroStep[] {
    const actions = pattern.split(' -> ').filter(Boolean);
    return actions.map(action => ({
      action: action.trim(),
      params: {},
      description: `Step: ${action.trim()}`,
    }));
  }
}
