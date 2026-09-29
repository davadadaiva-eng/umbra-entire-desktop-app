import { LLMConnector } from './LLMConnector';
import { HttpBridge } from './HttpBridge';

jest.mock('./HttpBridge');

function configWith(provider: 'openai' | 'anthropic' | 'ollama' | 'openai-compatible', extra: Record<string, unknown> = {}) {
  return {
    provider,
    models: { provider, reasoning: 'model-r', vision: 'model-v', fast: 'model-f' },
    openai: provider === 'openai' ? { endpoint: 'http://fake/v1', apiKey: 'sk-test' } : undefined,
    anthropic: provider === 'anthropic' ? { apiKey: 'sk-ant-test' } : undefined,
    ollama: provider === 'ollama' ? { endpoint: 'http://fake-ollama' } : undefined,
    openaiCompatible: provider === 'openai-compatible' ? { endpoint: 'http://fake-deepseek/v1', apiKey: 'dk-test' } : undefined,
    ...extra,
  } as any;
}

const DECLS = [
  {
    type: 'function' as const,
    function: {
      name: 'gmail_send_message',
      description: 'Send an email',
      parameters: { type: 'object', properties: { to: { type: 'string' } }, required: ['to'] },
    },
  },
];

describe('LLMConnector — native tool calling', () => {
  const mockPost = HttpBridge.post as jest.MockedFunction<typeof HttpBridge.post>;

  afterEach(() => {
    mockPost.mockReset();
  });

  it('sends the tools block to OpenAI-compatible endpoints (DeepSeek) and parses tool_calls', async () => {
    let body: any;
    mockPost.mockImplementation(async (_url: string, reqBody: any) => {
      body = reqBody;
      return {
        status: 200,
        data: {
          choices: [{
            message: {
              content: '',
              tool_calls: [{
                id: 'call_1',
                type: 'function',
                function: { name: 'gmail_send_message', arguments: '{"to":"a@b.c"}' },
              }],
            },
            finish_reason: 'tool_calls',
          }],
          model: 'deepseek-chat',
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        },
        text: '{}',
      };
    });

    const llm = new LLMConnector(configWith('openai-compatible'));
    const res = await llm.complete([{ role: 'user', content: 'send an email' }], 'reasoning', { tools: DECLS });

    expect(body.tools).toEqual(DECLS);
    expect(body.tool_choice).toBeUndefined(); // 'auto' is the default — not sent
    expect(res.toolCalls).toHaveLength(1);
    expect(res.toolCalls![0].name).toBe('gmail_send_message');
    expect(res.toolCalls![0].arguments).toEqual({ to: 'a@b.c' });
    expect(res.finishReason).toBe('tool_calls');
    expect(res.nativeToolsSupported).toBe(true);
  });

  it('maps tool_choice required/none to OpenAI and Anthropic bodies', async () => {
    let openaiBody: any;
    let anthropicBody: any;

    mockPost.mockImplementation(async (url: string, reqBody: any) => {
      if (String(url).includes('fake/v1')) {
        openaiBody = reqBody;
        return { status: 200, data: { choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }], model: 'x', usage: {} }, text: '{}' };
      }
      anthropicBody = reqBody;
      return {
        status: 200,
        data: { content: [{ type: 'text', text: 'ok' }], model: 'claude-x', usage: { input_tokens: 1, output_tokens: 1 }, stop_reason: 'end_turn' },
        text: '{}',
      };
    });

    const llm = new LLMConnector(configWith('openai'));
    await llm.complete([{ role: 'user', content: 'hi' }], 'reasoning', { tools: DECLS, toolChoice: 'required' });
    expect(openaiBody.tool_choice).toBe('required');
    expect(openaiBody.tools).toEqual(DECLS);

    const llm2 = new LLMConnector(configWith('anthropic'));
    await llm2.complete([{ role: 'user', content: 'hi' }], 'reasoning', { tools: DECLS, toolChoice: 'none' });
    expect(anthropicBody.tools[0].name).toBe('gmail_send_message');
    expect(anthropicBody.tools[0].input_schema).toEqual(DECLS[0].function.parameters);
    expect(anthropicBody.tool_choice).toEqual({ type: 'none' });
  });

  it('parses Anthropic tool_use blocks and joins text parts', async () => {
    mockPost.mockImplementation(async () => ({
      status: 200,
      data: {
        content: [
          { type: 'text', text: 'Let me check that.' },
          { type: 'tool_use', id: 'toolu_1', name: 'gmail_send_message', input: { to: 'a@b.c' } },
        ],
        model: 'claude-x',
        usage: { input_tokens: 10, output_tokens: 5 },
        stop_reason: 'tool_use',
      },
      text: '{}',
    }));

    const llm = new LLMConnector(configWith('anthropic'));
    const res = await llm.complete([{ role: 'user', content: 'send an email' }], 'reasoning', { tools: DECLS });

    expect(res.content).toBe('Let me check that.');
    expect(res.toolCalls).toHaveLength(1);
    expect(res.toolCalls![0]).toEqual({ id: 'toolu_1', name: 'gmail_send_message', arguments: { to: 'a@b.c' } });
    expect(res.finishReason).toBe('tool_calls');
  });

  it('sends tools to Ollama and parses its tool_calls shape', async () => {
    let body: any;
    mockPost.mockImplementation(async (_url: string, reqBody: any) => {
      body = reqBody;
      return {
        status: 200,
        data: {
          message: {
            content: '',
            tool_calls: [{ function: { name: 'gmail_send_message', arguments: { to: 'a@b.c' } } }],
          },
          done_reason: 'stop',
          prompt_eval_count: 3,
          eval_count: 7,
        },
        text: '{}',
      };
    });

    const llm = new LLMConnector(configWith('ollama'));
    const res = await llm.complete([{ role: 'user', content: 'send an email' }], 'reasoning', { tools: DECLS });

    expect(body.tools).toEqual(DECLS);
    expect(res.toolCalls![0].arguments).toEqual({ to: 'a@b.c' });
    expect(res.nativeToolsSupported).toBe(true);
  });

  it('leaves the request untouched when no tools are passed (back-compat)', async () => {
    let body: any;
    mockPost.mockImplementation(async (_url: string, reqBody: any) => {
      body = reqBody;
      return { status: 200, data: { choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }], model: 'x', usage: {} }, text: '{}' };
    });

    const llm = new LLMConnector(configWith('openai'));
    await llm.complete([{ role: 'user', content: 'hi' }], 'reasoning');
    expect(body.tools).toBeUndefined();
  });
});
