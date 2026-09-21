import { LLMConnector } from './LLMConnector';
import { HttpBridge } from './HttpBridge';

jest.mock('./HttpBridge');

function configWith(provider: 'openai' | 'anthropic', extra: Record<string, unknown> = {}) {
  return {
    provider,
    models: { provider, reasoning: 'model-r', vision: 'model-v', fast: 'model-f' },
    openai: provider === 'openai' ? { endpoint: 'http://fake/v1', apiKey: 'sk-test' } : undefined,
    anthropic: provider === 'anthropic' ? { apiKey: 'sk-ant-test' } : undefined,
    ...extra,
  } as any;
}

describe('LLMConnector', () => {
  const mockPost = HttpBridge.post as jest.MockedFunction<typeof HttpBridge.post>;

  afterEach(() => {
    mockPost.mockReset();
  });

  it('adds an ephemeral cache_control on the Anthropic system prompt (prompt caching)', async () => {
    let body: any;
    mockPost.mockImplementation(async (url: string, reqBody: any) => {
      body = reqBody;
      return {
        status: 200,
        data: {
          content: [{ type: 'text', text: 'ok' }],
          model: 'claude-x',
          usage: { input_tokens: 10, output_tokens: 5 },
          stop_reason: 'end_turn',
        },
        text: JSON.stringify({
          content: [{ type: 'text', text: 'ok' }],
          model: 'claude-x',
          usage: { input_tokens: 10, output_tokens: 5 },
          stop_reason: 'end_turn',
        }),
      };
    });

    const llm = new LLMConnector(configWith('anthropic'));
    await llm.complete(
      [
        { role: 'system', content: 'You are Umbra.' },
        { role: 'user', content: 'hi' },
      ],
      'reasoning',
    );

    expect(body.system).toEqual([
      { type: 'text', text: 'You are Umbra.', cache_control: { type: 'ephemeral' } },
    ]);
  });

  it('keeps the OpenAI payload cache-agnostic (natural prefix caching)', async () => {
    let body: any;
    mockPost.mockImplementation(async (url: string, reqBody: any) => {
      body = reqBody;
      return {
        status: 200,
        data: {
          choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
          model: 'gpt-x',
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        },
        text: JSON.stringify({
          choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
          model: 'gpt-x',
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }),
      };
    });

    const llm = new LLMConnector(configWith('openai'));
    await llm.complete([{ role: 'user', content: 'hi' }], 'fast');
    expect(body.messages[0].role).toBe('user');
    expect(body.messages[0].content).toBe('hi');
  });
});
