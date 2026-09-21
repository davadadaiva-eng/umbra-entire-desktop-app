import { ScreenContent } from './ScreenReader';
import { LLMConnector, LLMMessage } from '../agent/LLMConnector';
import { InjectionGuard } from '../agent/InjectionGuard';

export interface TaskContext {
  domain: string;
  description: string;
  projectName?: string;
  urgency: 'low' | 'medium' | 'high';
  currentTools: string[];
  detectedIntent: string;
}

export interface ContextSummary {
  screenContent: ScreenContent;
  taskContext: TaskContext;
  learnedPatterns: string[];
  suggestedActions: string[];
  privacySummary: { blocksCount: number; categories: string[] };
}

export class ContentAnalyzer {
  private llm?: LLMConnector;
  private injectionGuard = new InjectionGuard();

  setLLM(llm: LLMConnector): void {
    this.llm = llm;
  }

  async analyze(content: ScreenContent): Promise<ContextSummary> {
    const taskContext = await this.inferTaskContext(content);
    const learnedPatterns = this.extractPatterns(content);
    const suggestedActions = await this.suggestActions(content, taskContext);

    const categories = [...new Set(content.privacyBlocks.map(b => b.category))];

    return {
      screenContent: content,
      taskContext,
      learnedPatterns,
      suggestedActions,
      privacySummary: {
        blocksCount: content.privacyBlocks.length,
        categories,
      },
    };
  }

  private async inferTaskContext(content: ScreenContent): Promise<TaskContext> {
    const now = new Date();
    const hour = now.getHours();
    const allText = content.filteredText;

    let domain = 'general';
    let description = allText.substring(0, 200);
    let urgency: 'low' | 'medium' | 'high' = 'low';
    const tools: string[] = [];
    let intent = 'browsing';

    if (!this.llm || allText.length < 30) {
      return this.fallbackAnalysis(allText, content, hour);
    }

    try {
      const messages: LLMMessage[] = [
        {
          role: 'system',
          content: `Analyze what the user is doing based on the screen text below. Return ONLY valid JSON:
{
  "domain": "one word: development | communication | research | design | media | terminal | email | general",
  "description": "one sentence summary of what they are doing",
  "projectName": "project name if detectable (e.g. umbra-os, my-app), or null",
  "urgency": "low | medium | high (high only if errors/deployments/deadlines visible)",
  "tools": ["tool1", "tool2"],
  "intent": "short phrase like fixing_error | reviewing_code | writing_docs | searching | reading_email | chatting | coding | deploying | planning | learning | browsing"
}`,
        },
        { role: 'user', content: this.injectionGuard.scrub(`Screen text captured via OCR:\n\n${allText.substring(0, 3000)}`, 'ocr-screen').text },
      ];
      const result = await this.llm.complete(messages, 'fast', { temperature: 0.1, maxTokens: 500 });
      const parsed = JSON.parse(result.content);
      if (parsed.domain) domain = parsed.domain;
      if (parsed.description) description = parsed.description;
      if (parsed.urgency) urgency = parsed.urgency;
      if (Array.isArray(parsed.tools)) tools.push(...parsed.tools);
      if (parsed.intent) intent = parsed.intent;
    } catch {
      return this.fallbackAnalysis(allText, content, hour);
    }

    return { domain, description, urgency, currentTools: [...new Set(tools)], detectedIntent: intent };
  }

  private fallbackAnalysis(allText: string, content: ScreenContent, hour: number): TaskContext {
    const low = allText.toLowerCase();
    let domain = 'general';
    let urgency: 'low' | 'medium' | 'high' = 'low';
    const tools: string[] = [];
    let intent = 'browsing';

    if (/error|exception|failed|crash|timeout/i.test(low)) { urgency = 'high'; domain = 'development/debugging'; intent = 'fixing_error'; }
    if (/terminal|npm|git |docker|build|compile/i.test(low)) { tools.push('terminal'); if (domain === 'general') domain = 'development'; }
    if (/pull request|merge|review|github|gitlab/i.test(low)) { tools.push('git'); domain = 'development/code_review'; intent = 'reviewing_code'; }

    if (content.url) {
      if (/github|gitlab/.test(content.url)) { tools.push('github'); domain = 'development'; }
      if (/docs\.|notion|confluence/.test(content.url)) { domain = 'research/documentation'; intent = 'reading_docs'; }
      if (/mail|outlook|gmail/.test(content.url)) { domain = 'communication/email'; tools.push('email'); intent = 'reading_email'; }
      if (/chat|slack|discord/.test(content.url)) { domain = 'communication/chat'; tools.push('chat'); intent = 'messaging'; }
      if (/google\.com\/search|bing\.com\/search|duckduckgo/.test(content.url)) { domain = 'research/search'; intent = 'searching'; }
    }

    if (hour >= 9 && hour <= 12) domain += ' (morning work)';
    else if (hour >= 13 && hour <= 17) domain += ' (afternoon work)';

    return { domain, description: allText.substring(0, 200), urgency, currentTools: [...new Set(tools)], detectedIntent: intent };
  }

  private extractPatterns(content: ScreenContent): string[] {
    const patterns: string[] = [];
    const allText = content.filteredText.toLowerCase();

    if (/error|exception|failed|crash|timeout/i.test(allText)) patterns.push('debugging');
    if (/pull request|merge|review|pr\s#/i.test(allText)) patterns.push('code_review');
    if (/search|find|look up|research/i.test(allText)) patterns.push('researching');
    if (/write|edit|modify|refactor|implement/i.test(allText)) patterns.push('coding');
    if (/deploy|release|publish|ship/i.test(allText)) patterns.push('deploying');
    if (/plan|design|architect|proposal/i.test(allText)) patterns.push('planning');
    if (/meeting|sync|standup|call|discuss/i.test(allText)) patterns.push('meeting');
    if (/learn|read|doc|tutorial|guide/i.test(allText)) patterns.push('learning');

    return patterns;
  }

  private async suggestActions(content: ScreenContent, context: TaskContext): Promise<string[]> {
    const suggestions: string[] = [];

    if (context.detectedIntent === 'fixing_error') {
      suggestions.push('Search knowledge base for similar errors');
      suggestions.push('Offer to fix the error on Desktop 2');
    }

    if (context.detectedIntent === 'code_review') {
      suggestions.push('Summarize the PR for faster review');
      suggestions.push('Check if CI/tests pass');
    }

    if (context.currentTools.includes('terminal')) {
      suggestions.push('Monitor terminal output for errors');
      suggestions.push('Offer to run the next command');
    }

    if (context.urgency === 'high') {
      suggestions.unshift('Prioritize — high urgency detected');
    }

    if (this.llm && content.filteredText.length > 50) {
      try {
        const messages: LLMMessage[] = [
          {
            role: 'system',
            content: 'Based on the screen content, suggest 1-3 things the AI assistant could do to help. Return as JSON array of strings. Be specific and actionable.',
          },
          { role: 'user', content: this.injectionGuard.scrub(`Screen text: ${content.filteredText.substring(0, 1500)}\nDomain: ${context.domain}\nIntent: ${context.detectedIntent}`, 'screen-suggestions').text },
        ];
        const result = await this.llm.complete(messages, 'fast', { temperature: 0.2, maxTokens: 500 });
        try {
          const aiSuggestions = JSON.parse(result.content);
          if (Array.isArray(aiSuggestions)) suggestions.push(...aiSuggestions);
        } catch { }
      } catch { }
    }

    return [...new Set(suggestions)].slice(0, 5);
  }
}
