/**
 * Local-model test — drives Umbra's real LLMConnector against the local
 * llama.cpp server (OpenAI-compatible, no API key) to prove tasks can run
 * on a free on-device model.
 *
 * Requires llama-server on http://127.0.0.1:8080 (scripts/start-local-model.sh).
 *
 *   npx ts-node scripts/local-model-test.ts
 */
import { LLMConnector } from '../src/core/agent/LLMConnector';
import { UmbraConfig } from '../src/types';

async function main() {
  const config = {
    provider: 'openai-compatible',
    openaiCompatible: { endpoint: 'http://127.0.0.1:8080/v1', apiKey: '' },
    models: {
      fast: 'qwen2.5-0.5b-instruct',
      reasoning: 'qwen2.5-0.5b-instruct',
      vision: 'qwen2.5-0.5b-instruct',
    },
  } as unknown as UmbraConfig;

  const llm = new LLMConnector(config);
  const res = await llm.complete(
    [{ role: 'user', content: 'Reply with exactly: UMBRA_LOCAL_OK' }],
    'fast',
    { temperature: 0, maxTokens: 32 },
  );

  console.log(JSON.stringify({
    content: res.content.trim(),
    modelUsed: res.modelUsed,
    totalTokens: res.totalTokens,
  }, null, 2));
  console.log('LOCAL_MODEL_TEST_' + (res.content.includes('UMBRA_LOCAL_OK') ? 'PASS' : 'CHECK'));
}

main().catch(err => {
  console.error('LOCAL_MODEL_TEST_FAIL', err);
  process.exit(1);
});
