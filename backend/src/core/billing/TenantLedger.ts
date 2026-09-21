/**
 * TenantLedger — multi-user budgets on one node.
 *
 * Turns the single-node budget model into a per-user one: each paying
 * customer ("tenant") gets their own ModelRouter (own tier, own $5/$10
 * monthly ceiling, own spend counters), while an install with no tenants
 * keeps working exactly as before through the default router.
 *
 * The *current* tenant is carried per-request through AsyncLocalStorage
 * (stdlib, no dependencies): API handlers wrap the request in
 * `TenantLedger.run(tenantId, fn)`, and the RoutedLLMConnector resolves
 * which router to meter against with `TenantLedger.current()`. LLM calls
 * made outside any request (scheduled background tasks, local node work)
 * fall back to the default node router — exactly the pre-tenant behavior.
 *
 * Tenant records + per-tenant spend counters persist under the data dir:
 *   dataDir/tenants/<id>.json   — spend ledger for that tenant
 *   dataDir/tenants.json        — tenant registry (tier, name, timestamps)
 */

import * as fs from 'fs';
import * as path from 'path';
import { AsyncLocalStorage } from 'async_hooks';
import { ModelRouter, RouterSnapshot } from '../metering/ModelRouter';
import { PlanTier, UmbraConfig } from '../../types';
import { deviceLimitLabel, maxDevicesForTier } from '../../p2p/DevicePolicy';
import { getLogger } from '../Logger';

export interface TenantRecord {
  /** Stable identifier — Stripe customer id, device id, or any operator key. */
  id: string;
  name?: string;
  tier: PlanTier;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface TenantStatus extends TenantRecord {
  /** Numeric device cap (Infinity = unlimited). */
  deviceLimit: number;
  deviceLimitLabel: number | 'unlimited';
  usage?: RouterSnapshot;
}

export interface TenantLedgerOptions {
  config: UmbraConfig;
  dataDir: string;
  /** The node's own router — used when no tenant context is active. */
  defaultRouter: ModelRouter;
  /** Optional JSON path for the tenant registry (default: dataDir/tenants.json). */
  persistPath?: string;
  /** Injectable clock for deterministic tests. */
  now?: () => Date;
}

const tenantStore = new AsyncLocalStorage<string | undefined>();

export class TenantLedger {
  /** Active tenant for the current request chain, if any. */
  static current(): string | undefined {
    return tenantStore.getStore();
  }

  /** Run `fn` with `tenantId` bound to the current async chain. */
  static run<T>(tenantId: string | undefined, fn: () => Promise<T>): Promise<T> {
    return tenantStore.run(tenantId, fn);
  }

  private config: UmbraConfig;
  private dataDir: string;
  private defaultRouter: ModelRouter;
  private persistPath: string;
  private now: () => Date;
  private records = new Map<string, TenantRecord>();
  private routers = new Map<string, ModelRouter>();

  constructor(options: TenantLedgerOptions) {
    this.config = options.config;
    this.dataDir = options.dataDir;
    this.defaultRouter = options.defaultRouter;
    this.persistPath = options.persistPath || path.join(options.dataDir, 'tenants.json');
    this.now = options.now ?? (() => new Date());
    this.load();
  }

  get enabled(): boolean {
    return this.records.size > 0;
  }

  /** Router for the given tenant (falls back to the node default). */
  routerFor(tenantId?: string): ModelRouter {
    if (!tenantId) return this.defaultRouter;
    const record = this.records.get(tenantId);
    if (!record || !record.enabled) return this.defaultRouter;
    let router = this.routers.get(tenantId);
    if (!router) {
      const tenantConfig: UmbraConfig = {
        ...this.config,
        plan: { ...this.config.plan, tier: record.tier },
      };
      router = new ModelRouter({
        config: tenantConfig,
        persistPath: path.join(this.dataDir, 'tenants', `${this.safe(tenantId)}.json`),
        now: this.now,
      });
      this.routers.set(tenantId, router);
    }
    return router;
  }

  /** The tenant active on the current async chain (if registered + enabled). */
  currentTenant(): string | undefined {
    const id = TenantLedger.current();
    return id && this.records.has(id) && this.records.get(id)!.enabled ? id : undefined;
  }

  /** Register (or update) a tenant and return its status. */
  register(record: { id: string; name?: string; tier?: PlanTier; enabled?: boolean }): TenantStatus {
    const id = String(record.id || '').trim();
    if (!id) throw new Error('tenant id is required');
    const existing = this.records.get(id);
    const tier = (record.tier ?? existing?.tier ?? 'free') as PlanTier;
    const now = new Date(this.now()).toISOString();
    const next: TenantRecord = {
      id,
      name: record.name ?? existing?.name,
      tier,
      enabled: record.enabled ?? existing?.enabled ?? true,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.records.set(id, next);
    this.routers.delete(id); // tier may have changed — rebuild its router lazily
    this.persist();
    return this.status(id);
  }

  /** Activate a plan for a tenant (no-op unknown tiers → free). */
  activate(tenantId: string, tier: PlanTier | string): TenantStatus {
    const record = this.records.get(tenantId);
    if (!record) throw new Error(`Unknown tenant: ${tenantId}`);
    const valid: PlanTier[] = ['free', 'byok', 'pro', 'ultimate', 'enterprise'];
    const nextTier = valid.includes(tier as PlanTier) ? (tier as PlanTier) : 'free';
    return this.register({ id: tenantId, tier: nextTier, enabled: true });
  }

  /** Disable a tenant — its router falls back to the node default afterwards. */
  disable(tenantId: string): TenantStatus {
    return this.register({ id: tenantId, enabled: false });
  }

  /** Per-tenant device cap (Infinity = unlimited). */
  deviceLimit(tenantId: string): number {
    const record = this.records.get(tenantId);
    const raw = record ? maxDevicesForTier(record.tier) : maxDevicesForTier('free');
    return raw === 'unlimited' ? Infinity : Number(raw);
  }

  /** Full status (plan + usage snapshot) for one tenant. */
  status(tenantId: string): TenantStatus {
    const record = this.records.get(tenantId);
    if (!record) throw new Error(`Unknown tenant: ${tenantId}`);
    const limit = this.deviceLimit(tenantId);
    return {
      ...record,
      deviceLimit: limit,
      deviceLimitLabel: deviceLimitLabel(record.tier),
      usage: this.routerFor(tenantId).snapshot(),
    };
  }

  /** Status of every registered tenant. */
  statuses(): TenantStatus[] {
    return [...this.records.keys()].map(id => this.status(id));
  }

  private safe(id: string): string {
    return id.replace(/[^a-zA-Z0-9._-]/g, '_');
  }

  // ── Persistence ──────────────────────────────────────────────

  private persist(): void {
    try {
      fs.mkdirSync(path.dirname(this.persistPath), { recursive: true });
      fs.writeFileSync(this.persistPath, JSON.stringify({
        version: 1,
        tenants: [...this.records.values()],
      }, null, 2), 'utf-8');
    } catch (err: any) {
      // Best-effort persistence; in-memory registry remains authoritative.
      getLogger().warn({ err: err?.message }, 'Failed to persist tenant registry');
    }
  }

  private load(): void {
    if (!fs.existsSync(this.persistPath)) return;
    try {
      const raw = JSON.parse(fs.readFileSync(this.persistPath, 'utf-8'));
      const list = Array.isArray(raw?.tenants) ? raw.tenants : [];
      for (const item of list) {
        if (!item || typeof item.id !== 'string' || !item.id) continue;
        this.records.set(item.id, {
          id: item.id,
          name: typeof item.name === 'string' ? item.name : undefined,
          tier: ['free', 'byok', 'pro', 'ultimate'].includes(item.tier) ? item.tier : 'free',
          enabled: item.enabled !== false,
          createdAt: typeof item.createdAt === 'string' ? item.createdAt : new Date().toISOString(),
          updatedAt: typeof item.updatedAt === 'string' ? item.updatedAt : new Date().toISOString(),
        });
      }
    } catch {
      // Corrupt registry → start clean.
    }
  }
}