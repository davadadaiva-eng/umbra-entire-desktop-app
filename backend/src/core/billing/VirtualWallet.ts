/**
 * VirtualWallet — JIT financial safety ceiling.
 * Per-user model budgets (PRO 5 / ADVANCED 10 / ENTERPRISE 30),
 * stored in `users.ai_budget_limit` (see UserStore.migrateJIT).
 * On every OpenRouter response we deduct exact cost (incl. cache_read)
 * and when <= 0 we force spillover to the free model.
 * Hetzner server stays running — only API costs go to zero.
 *
 * Budget breakdown by tier (see ../metering/pricing.ts — single source):
 *   - Pro:        5 models,  €6.70 cloud VPS,  0 telco
 *   - Advanced:   10 models, €10 cloud VPS,    0 telco
 *   - Enterprise: 30 models, €29.99 cloud VPS, 15 telco
 */
import { UserStore } from '../auth/UserStore';
import { walletBudgets } from '../metering/pricing';
import { getLogger } from '../Logger';

export interface WalletBudgets {
  models: number;
  cloud: number;
  telco: number;
}

export class VirtualWallet {
  constructor(private users: UserStore) {}

  init(userId: string, tier: string): void {
    const budgets = this.getBudgets(tier);
    this.users.initWallet(userId, tier, budgets.models);
  }

  getBudgets(tier: string): WalletBudgets {
    return walletBudgets(tier);
  }

  balance(userId: string): number {
    return this.users.getWallet(userId);
  }

  depleted(userId: string): boolean {
    return this.users.isWalletDepleted(userId);
  }

  deduct(userId: string, cost: number): number {
    const remaining = this.users.deductWallet(userId, cost);
    if (remaining <= 0) {
      getLogger().warn({ userId, cost, remaining }, 'Wallet depleted — forcing free tier fallback');
    }
    return remaining;
  }

  /** Link Hetzner server for later teardown */
  linkServer(userId: string, serverId: number): void {
    this.users.setHetznerServerId(userId, serverId);
  }

  linkStripe(userId: string, customerId: string, subscriptionId?: string): void {
    this.users.linkStripeCustomer(userId, customerId, subscriptionId);
  }
}
