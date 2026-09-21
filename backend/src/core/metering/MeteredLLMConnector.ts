/**
 * MeteredLLMConnector — wraps LLMConnector so every completion is:
 *   1. gated by the plan tier (canAfford pre-check on estimated tokens),
 *   2. guarded by a circuit breaker (fail fast on flaky providers),
 *   3. token-accounted after the call (recordTokens from usage).
 *
 * It is an LLMConnector, so it can be passed anywhere the base class is
 * used and the metering is invisible to callers.
 */

import { LLMConnector, LLMMessage, LLMCompletionOptions, LLMCompletionResult } from '../agent/LLMConnector';
import { estimateTokens } from '../graphify/Caveman';
import { MeteringService } from './MeteringService';
import { UmbraConfig } from '../../types';

export class MeteredLLMConnector extends LLMConnector {
  protected metering: MeteringService;

  constructor(config: UmbraConfig, metering: MeteringService) {
    super(config);
    this.metering = metering;
  }

  async complete(
    messages: LLMMessage[],
    role: 'reasoning' | 'vision' | 'fast' = 'reasoning',
    options: LLMCompletionOptions = {}
  ): Promise<LLMCompletionResult> {
    const service = `llm:${this.providerName}`;

    // Circuit breaker: fail fast instead of burning budget on a flaky provider.
    if (!this.metering.allow(service)) {
      const state = this.metering.circuitStates().find(c => c.service === service);
      throw new Error(
        `LLM circuit breaker open for ${service}${state?.openedAt ? ` (opened ${new Date(state.openedAt).toISOString()})` : ''} — skipping call to avoid burning budget`,
      );
    }

    // Affordability gate: rough pre-flight estimate of the whole round trip.
    const inputTokens = messages.reduce((acc, m) => {
      const content = typeof m.content === 'string'
        ? m.content
        : m.content.map(c => (c.type === 'text' ? c.text : '')).join(' ');
      return acc + estimateTokens(content);
    }, 0);
    const estimated = inputTokens + (options.maxTokens ?? 4096);
    if (!this.metering.canAfford(estimated)) {
      const snap = this.metering.snapshot();
      throw new Error(
        `Plan limit reached: ~${estimated} tokens requested, ${snap.remainingTokens} remaining (${snap.tokensUsed}/${snap.tokensLimit})`,
      );
    }

    try {
      const result = await super.complete(messages, role, options);
      this.metering.recordTokens(result.totalTokens || 0);
      this.metering.reportSuccess(service);
      return result;
    } catch (err) {
      this.metering.reportFailure(service);
      throw err;
    }
  }
}
