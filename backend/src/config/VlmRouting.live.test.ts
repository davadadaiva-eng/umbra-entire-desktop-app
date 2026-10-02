/**
 * LIVE integration check (opt-in): UMBRA_LIVE_VLM=1 npx jest src/config/VlmRouting.live.test.ts
 *
 * Boots the real config (applyOpenRouterDefault + stale-slot refresh) and
 * issues a real vision completion through RoutedLLMConnector. Skipped by
 * default so `npm test` never touches the network.
 */
import { ConfigManager } from './ConfigManager';
import { RoutedLLMConnector } from '../core/metering/RoutedLLMConnector';
import { MeteringService } from '../core/metering/MeteringService';
import { ModelRouter } from '../core/metering/ModelRouter';

const live = !!process.env.UMBRA_LIVE_VLM;

(live ? describe : describe.skip)('VLM routing (LIVE, UMBRA_LIVE_VLM=1)', () => {
  it('routes image input to a vision-capable model against the real OpenRouter API', async () => {
    const cm = new ConfigManager();
    await cm.initialize();
    const config = cm.raw;

    // eslint-disable-next-line no-console
    console.log('provider:', config.provider, '| models.vision:', config.models.vision,
      '| routing.enabled:', config.plan.routing?.enabled, '| fast slot:', config.plan.routing?.fast.model);

    const metering = new MeteringService({ dataDir: config.paths.dataDir });
    const llm = new RoutedLLMConnector(config, metering, new ModelRouter({ config }));

    // 1x1 red PNG.
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const res = await llm.complete(
      [{
        role: 'user',
        content: [
          { type: 'text', text: 'Reply with one word: what color dominates this image?' },
          { type: 'image', image: png, detail: 'low' },
        ],
      }],
      'vision',
      { maxTokens: 60 },
    );

    // eslint-disable-next-line no-console
    console.log('VISION CALL OK — modelUsed:', res.modelUsed, '| answer:', res.content.trim().slice(0, 80));
    expect(res.content.trim().length).toBeGreaterThan(0);
  }, 120_000);
});
