import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ConfigManager } from './ConfigManager';

/**
 * Fixtures mirror a real stale config: slots written for an older lineup
 * (deepseek/muse) while the operator's key rides OpenRouter. RoutedLLMConnector
 * serves `vision` from the `fast` slot, so a text-only fast model 404s on
 * image input — applyOpenRouterDefault must re-pin unknown slot models.
 */
function staleRouting() {
  return {
    enabled: false,
    cacheHitRatio: 0.85,
    graphify: true,
    caveman: true,
    free: { provider: 'openai-compatible' as const, model: 'meta-llama/llama-3.1-8b-instruct:free', endpoint: 'https://openrouter.ai/api/v1', inputPerM: 0, cacheHitPerM: 0, outputPerM: 0 },
    fast: { provider: 'openai-compatible' as const, model: 'deepseek-v4-flash', inputPerM: 0.14, cacheHitPerM: 0.0028, outputPerM: 0.28 },
    reasoning: { provider: 'openai-compatible' as const, model: 'deepseek-r1', inputPerM: 0.55, cacheHitPerM: 0.14, outputPerM: 2.19 },
    frontend: { provider: 'openai-compatible' as const, model: 'muse-spark-1.2', inputPerM: 0.55, cacheHitPerM: 0.14, outputPerM: 2.19 },
    difficult: { provider: 'anthropic' as const, model: 'claude-sonnet-5', inputPerM: 3, cacheHitPerM: 0.3, outputPerM: 15 },
  };
}

describe('ConfigManager OpenRouter slot refresh', () => {
  let dir: string;
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'umbra-config-'));
    savedEnv = {
      OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
      UMBRA_LLM_PROVIDER: process.env.UMBRA_LLM_PROVIDER,
    };
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.UMBRA_LLM_PROVIDER;
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete (process.env as any)[k];
      else (process.env as any)[k] = v;
    }
  });

  function writeConfig(overlay: Record<string, unknown>): void {
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(overlay), 'utf-8');
  }

  it('re-pins stale (non-catalog) OpenRouter slot models when adopting the OpenRouter key', async () => {
    writeConfig({
      provider: 'ollama',
      openaiCompatible: { endpoint: 'https://openrouter.ai/api/v1', apiKey: 'sk-or-test' },
      plan: { tier: 'byok', routing: staleRouting() },
    });

    const cm = new ConfigManager(dir);
    await cm.initialize();
    const c = cm.raw;

    // Key adoption happened at all.
    expect(c.provider).toBe('openai-compatible');
    expect(c.plan.routing?.enabled).toBe(true);
    expect(c.models.vision).toBe('google/gemini-2.5-pro');

    // Stale openai-compatible slots re-pinned to the current catalog lineup.
    expect(c.plan.routing?.fast.model).toBe('google/gemini-2.5-flash');
    expect(c.plan.routing?.fast.inputPerM).toBe(0.3);
    expect(c.plan.routing?.reasoning.model).toBe('moonshotai/kimi-k3');
    expect(c.plan.routing?.frontend.model).toBe('google/gemini-2.5-flash');

    // Known models and non-OpenRouter providers are left alone.
    expect(c.plan.routing?.free.model).toBe('meta-llama/llama-3.1-8b-instruct:free');
    expect(c.plan.routing?.difficult.model).toBe('claude-sonnet-5');
    expect(c.plan.routing?.difficult.provider).toBe('anthropic');
  });

  it('keeps operator-customized slots that already name a catalog model', async () => {
    const routing = staleRouting();
    routing.fast = { ...routing.fast, model: 'google/gemini-2.5-pro' };
    writeConfig({
      provider: 'ollama',
      openaiCompatible: { endpoint: 'https://openrouter.ai/api/v1', apiKey: 'sk-or-test' },
      plan: { tier: 'byok', routing },
    });

    const cm = new ConfigManager(dir);
    await cm.initialize();

    expect(cm.raw.plan.routing?.fast.model).toBe('google/gemini-2.5-pro');
  });

  it('leaves a non-OpenRouter config untouched', async () => {
    writeConfig({ provider: 'ollama', plan: { tier: 'free', routing: staleRouting() } });

    const cm = new ConfigManager(dir);
    await cm.initialize();

    expect(cm.raw.provider).toBe('ollama');
    expect(cm.raw.plan.routing?.enabled).toBe(false);
    expect(cm.raw.plan.routing?.fast.model).toBe('deepseek-v4-flash');
  });
});
