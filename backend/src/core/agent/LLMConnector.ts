import { HttpBridge } from './HttpBridge';
import { UmbraConfig } from '../../types';

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | LLMContentPart[];
}

export type LLMContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; image: string; detail?: 'low' | 'high' | 'auto' };

export interface LLMCompletionOptions {
  model?: string;
  temperature?: number;
  maxTokens?: number;
  stream?: boolean;
  /** Task category hint for tiered model routing. */
  task?: 'general' | 'frontend' | 'difficult';
}

export interface LLMCompletionResult {
  content: string;
  modelUsed: string;
  totalTokens: number;
  finishReason: string;
  /** Input (prompt) tokens, when the provider reports them. */
  inputTokens?: number;
  /** Output (completion) tokens, when the provider reports them. */
  outputTokens?: number;
}

export class LLMConnector {
  private config: UmbraConfig;

  constructor(config: UmbraConfig) {
    this.config = config;
  }

  protected get providerName(): string {
    return this.config.provider;
  }

  protected get currentConfig(): UmbraConfig {
    return this.config;
  }

  async complete(
    messages: LLMMessage[],
    role: 'reasoning' | 'vision' | 'fast' = 'reasoning',
    options: LLMCompletionOptions = {}
  ): Promise<LLMCompletionResult> {
    const model = options.model || this.config.models[role];
    const provider = this.config.provider;

    switch (provider) {
      case 'ollama':
        return this.ollamaComplete(model, messages, options);
      case 'openai':
        return this.openaiComplete(model, messages, options);
      case 'anthropic':
        return this.anthropicComplete(model, messages, options);
      case 'openai-compatible':
        return this.openaiCompatibleComplete(model, messages, options);
      default:
        throw new Error(`Unsupported provider: ${provider}`);
    }
  }

  private async ollamaComplete(
    model: string,
    messages: LLMMessage[],
    options: LLMCompletionOptions
  ): Promise<LLMCompletionResult> {
    const endpoint = this.config.ollama?.endpoint || 'http://localhost:11434';
    const url = `${endpoint}/api/chat`;

    const body: any = {
      model,
      messages: messages.map(m => ({
        role: m.role,
        content: typeof m.content === 'string' ? m.content : m.content.map(c => this.ollamaContentPart(c)),
      })),
      stream: false,
      options: {
        temperature: options.temperature ?? 0.3,
        num_predict: Math.min(options.maxTokens ?? 1024, 1024),
      },
    };

    const res = await this.httpsPost(url, body, {}, 120000);

    if (res.status < 200 || res.status >= 300) {
      throw new Error(`Ollama error: ${res.status} ${res.text}`);
    }

    const rawContent = res.data.message?.content || '';
    const thinking = res.data.message?.thinking || '';
    // MiniCPM5 thinking models put real answer in `thinking` when content empty; merge both
    const content = rawContent || thinking || '';
    return {
      content,
      modelUsed: model,
      totalTokens: (res.data.prompt_eval_count || 0) + (res.data.eval_count || 0),
      inputTokens: res.data.prompt_eval_count || 0,
      outputTokens: res.data.eval_count || 0,
      finishReason: res.data.done_reason || 'stop',
    };
  }

  private ollamaContentPart(part: LLMContentPart): any {
    if (part.type === 'text') return { type: 'text', text: part.text };
    if (part.type === 'image') return { type: 'image', image: part.image };
    return part;
  }

  private async openaiComplete(
    model: string,
    messages: LLMMessage[],
    options: LLMCompletionOptions
  ): Promise<LLMCompletionResult> {
    const endpoint = this.config.openai?.endpoint || 'https://api.openai.com/v1';
    const apiKey = this.config.openai?.apiKey;

    const body: any = {
      model,
      messages: messages.map(m => ({
        role: m.role,
        content: typeof m.content === 'string' ? m.content : m.content.map(c => this.openaiContentPart(c)),
      })),
      temperature: options.temperature ?? 0.3,
      max_tokens: options.maxTokens ?? 4096,
    };

    // Local OpenAI-compatible servers (llama.cpp, etc.) run without a key —
    // only attach Authorization when one is configured.
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

    const res = await this.httpsPost(`${endpoint}/chat/completions`, body, headers);

    if (res.status < 200 || res.status >= 300) throw new Error(`OpenAI error: ${res.status} ${res.text}`);

    return {
      content: res.data.choices?.[0]?.message?.content || '',
      modelUsed: res.data.model || model,
      totalTokens: res.data.usage?.total_tokens || 0,
      inputTokens: res.data.usage?.prompt_tokens || 0,
      outputTokens: res.data.usage?.completion_tokens || 0,
      finishReason: res.data.choices?.[0]?.finish_reason || 'stop',
    };
  }

  private openaiContentPart(part: LLMContentPart): any {
    if (part.type === 'text') return { type: 'text', text: part.text };
    if (part.type === 'image') return { type: 'image_url', image_url: { url: `data:image/png;base64,${part.image}`, detail: part.detail || 'auto' } };
    return part;
  }

  private async anthropicComplete(
    model: string,
    messages: LLMMessage[],
    options: LLMCompletionOptions
  ): Promise<LLMCompletionResult> {
    const apiKey = this.config.anthropic?.apiKey;
    if (!apiKey) throw new Error('Anthropic API key not configured');

    const systemMsg = messages.find(m => m.role === 'system');
    const otherMessages = messages.filter(m => m.role !== 'system');

    const body: any = {
      model,
      max_tokens: options.maxTokens ?? 4096,
      temperature: options.temperature ?? 0.3,
      // Prompt caching: mark the system prompt as ephemeral-cacheable so
      // repeated calls with the same prefix pay cache-hit input prices
      // (the router's cost model already assumes a cache-hit ratio).
      system: systemMsg
        ? typeof systemMsg.content === 'string'
          ? [{ type: 'text', text: systemMsg.content, cache_control: { type: 'ephemeral' } }]
          : systemMsg.content.map(c => (c.type === 'text' ? { ...c, cache_control: { type: 'ephemeral' } } : c))
        : undefined,
      messages: otherMessages.map(m => ({
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content: typeof m.content === 'string' ? m.content : m.content.map(c => this.anthropicContentPart(c)),
      })),
    };

    const res = await this.httpsPost('https://api.anthropic.com/v1/messages', body, {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    });

    if (res.status < 200 || res.status >= 300) throw new Error(`Anthropic error: ${res.status} ${res.text}`);

    return {
      content: res.data.content?.[0]?.text || '',
      modelUsed: res.data.model || model,
      totalTokens: (res.data.usage?.input_tokens || 0) + (res.data.usage?.output_tokens || 0),
      inputTokens: res.data.usage?.input_tokens || 0,
      outputTokens: res.data.usage?.output_tokens || 0,
      finishReason: res.data.stop_reason || 'stop',
    };
  }

  private anthropicContentPart(part: LLMContentPart): any {
    if (part.type === 'text') return { type: 'text', text: part.text };
    if (part.type === 'image') return { type: 'image', source: { type: 'base64', media_type: 'image/png', data: part.image } };
    return part;
  }

  private async openaiCompatibleComplete(
    model: string,
    messages: LLMMessage[],
    options: LLMCompletionOptions
  ): Promise<LLMCompletionResult> {
    if (!this.config.openaiCompatible?.endpoint) throw new Error('OpenAI-compatible endpoint not configured');
    const endpoint = this.config.openaiCompatible.endpoint;
    const apiKey = this.config.openaiCompatible.apiKey;

    const body: any = {
      model,
      messages: messages.map(m => ({
        role: m.role,
        content: typeof m.content === 'string' ? m.content : m.content.map(c => this.openaiContentPart(c)),
      })),
      temperature: options.temperature ?? 0.3,
      max_tokens: options.maxTokens ?? 4096,
    };

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

    const res = await this.httpsPost(`${endpoint}/chat/completions`, body, headers);

    if (res.status < 200 || res.status >= 300) throw new Error(`OpenAI-compatible error: ${res.status} ${res.text}`);

    return {
      content: res.data.choices?.[0]?.message?.content || '',
      modelUsed: res.data.model || model,
      totalTokens: res.data.usage?.total_tokens || 0,
      inputTokens: res.data.usage?.prompt_tokens || 0,
      outputTokens: res.data.usage?.completion_tokens || 0,
      finishReason: res.data.choices?.[0]?.finish_reason || 'stop',
    };
  }

  async createEmbedding(text: string): Promise<number[]> {
    const endpoint = this.config.ollama?.endpoint || 'http://localhost:11434';
    const model = this.config.models.embedding || 'nomic-embed-text';

    const res = await this.httpsPost(`${endpoint}/api/embeddings`, { model, prompt: text });

    if (res.status < 200 || res.status >= 300) throw new Error(`Embedding error: ${res.status}`);
    return res.data.embedding || [];
  }

  updateConfig(config: UmbraConfig): void {
    this.config = config;
  }

  /** POST JSON via curl.exe (bypasses Node v24 TLS stack). */
  private httpsPost(url: string, body: any, headers: Record<string, string> = {}, timeoutMs = 60000): Promise<{ status: number; data: any; text: string }> {
    return HttpBridge.post(url, body, headers, timeoutMs);
  }
}
