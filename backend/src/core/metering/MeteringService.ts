/**
 * Metering & Plan — tracks usage against a plan tier and gates expensive
 * work with circuit breakers. A tripped breaker fails fast instead of
 * burning budget on a flaky backend.
 */

import { PlanTier } from '../../types';

export interface TierLimits {
  monthlyTokens: number;
  maxMemoryBytes: number;
  maxConcurrentSessions: number;
  metered: boolean;
}

export const TIER_LIMITS: Record<PlanTier, TierLimits> = {
  free: { monthlyTokens: 100_000, maxMemoryBytes: 512 * 1024 * 1024, maxConcurrentSessions: 1, metered: false },
  byok: { monthlyTokens: 1_000_000, maxMemoryBytes: 2 * 1024 * 1024 * 1024, maxConcurrentSessions: 2, metered: false },
  pro: { monthlyTokens: 10_000_000, maxMemoryBytes: 8 * 1024 * 1024 * 1024, maxConcurrentSessions: 8, metered: true },
  ultimate: { monthlyTokens: 50_000_000, maxMemoryBytes: 16 * 1024 * 1024 * 1024, maxConcurrentSessions: 16, metered: true },
  enterprise: { monthlyTokens: Infinity, maxMemoryBytes: Infinity, maxConcurrentSessions: Infinity, metered: true },
};

/** Resolve a routing tier string to a canonical PlanTier. 'advanced' is an alias for 'ultimate'. */
export function resolveTier(tier: string): PlanTier {
  return tier === 'advanced' ? 'ultimate' : (tier as PlanTier);
}

export interface UsageSnapshot {
  tokensUsed: number;
  tokensLimit: number;
  memoryUsedBytes: number;
  memoryLimitBytes: number;
  activeSessions: number;
  sessionsLimit: number;
  remainingTokens: number;
}

export interface CircuitState {
  service: string;
  state: 'closed' | 'open' | 'half-open';
  failures: number;
  threshold: number;
  lastFailureAt?: number;
  openedAt?: number;
}

export interface MeteringOptions {
  tier?: PlanTier;
  dataDir: string;
  circuitThreshold?: number;
  /** ms a circuit stays open before half-open probe. */
  resetTimeoutMs?: number;
}

export class MeteringService {
  private tier: PlanTier;
  private dataDir: string;
  private threshold: number;
  private resetTimeoutMs: number;
  private tokensUsed = 0;
  private memoryUsedBytes = 0;
  private activeSessions = 0;
  private circuits = new Map<string, CircuitState>();

  constructor(options: MeteringOptions) {
    this.tier = options.tier ?? 'free';
    this.dataDir = options.dataDir;
    this.threshold = options.circuitThreshold ?? 5;
    this.resetTimeoutMs = options.resetTimeoutMs ?? 30_000;
  }

  get currentTier(): PlanTier {
    return this.tier;
  }

  setTier(tier: PlanTier): void {
    this.tier = tier;
  }

  get limits(): TierLimits {
    return TIER_LIMITS[this.tier];
  }

  recordTokens(count: number): void {
    this.tokensUsed += count;
  }

  recordMemory(bytes: number): void {
    this.memoryUsedBytes += bytes;
  }

  openSession(): boolean {
    if (this.activeSessions >= this.limits.maxConcurrentSessions) return false;
    this.activeSessions++;
    return true;
  }

  closeSession(): void {
    this.activeSessions = Math.max(0, this.activeSessions - 1);
  }

  /** Can this much work proceed under the current tier? */
  canAfford(tokens: number, memoryBytes = 0): boolean {
    return (
      this.tokensUsed + tokens <= this.limits.monthlyTokens &&
      this.memoryUsedBytes + memoryBytes <= this.limits.maxMemoryBytes
    );
  }

  snapshot(): UsageSnapshot {
    return {
      tokensUsed: this.tokensUsed,
      tokensLimit: this.limits.monthlyTokens,
      memoryUsedBytes: this.memoryUsedBytes,
      memoryLimitBytes: this.limits.maxMemoryBytes,
      activeSessions: this.activeSessions,
      sessionsLimit: this.limits.maxConcurrentSessions,
      remainingTokens: Math.max(0, this.limits.monthlyTokens - this.tokensUsed),
    };
  }

  // ── Circuit breakers ──────────────────────────────────────────

  allow(service: string): boolean {
    const circuit = this.circuits.get(service);
    if (!circuit || circuit.state === 'closed') return true;
    if (circuit.state === 'open') {
      if (circuit.openedAt && Date.now() - circuit.openedAt > this.resetTimeoutMs) {
        circuit.state = 'half-open';
        return true;
      }
      return false;
    }
    // half-open: single probe allowed, else fail.
    circuit.state = 'open';
    circuit.openedAt = Date.now();
    return false;
  }

  reportSuccess(service: string): void {
    const circuit = this.circuits.get(service);
    if (!circuit) return;
    circuit.failures = 0;
    circuit.state = 'closed';
    circuit.openedAt = undefined;
  }

  reportFailure(service: string): void {
    let circuit = this.circuits.get(service);
    if (!circuit) {
      circuit = { service, state: 'closed', failures: 0, threshold: this.threshold };
      this.circuits.set(service, circuit);
    }
    circuit.failures++;
    circuit.lastFailureAt = Date.now();
    if (circuit.failures >= this.threshold && circuit.state !== 'open') {
      circuit.state = 'open';
      circuit.openedAt = Date.now();
    }
  }

  circuitStates(): CircuitState[] {
    return [...this.circuits.values()];
  }
}
