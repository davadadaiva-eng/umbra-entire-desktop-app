import * as crypto from 'crypto';
import { getLogger } from '../Logger';

export interface StripeBillingOptions {
  /** Stripe secret API key (sk_...). Never hard-code — read from config/env/vault. */
  secretKey: string;
  /** Webhook signing secret (whsec_...) used to verify incoming events. */
  webhookSecret: string;
  /** Stripe price id per plan tier, e.g. { pro: 'price_...', ultimate: 'price_...' }. */
  priceIds: Record<string, string>;
  /** Public base URL used for success/cancel redirects (no trailing slash). */
  publicUrl: string;
  /** Called once a checkout completes — wire to UmbraOS.activatePlan (tier, tenantId?). */
  onPlanPaid: (tier: string, tenantId?: string) => Promise<unknown>;
  /** Called when a subscription is canceled — wire to cloud teardown. */
  onSubscriptionCanceled?: (customerId: string, subscriptionId: string) => Promise<unknown>;
  /** Injectable fetch for tests. */
  fetchImpl?: typeof fetch;
}

const STRIPE_API = 'https://api.stripe.com/v1';
/** Reject webhook timestamps older than this (replay protection). */
const MAX_WEBHOOK_AGE_MS = 5 * 60 * 1000;

/**
 * Minimal Stripe integration — checkout sessions + webhook verification.
 * Uses the Node 18+ global fetch and crypto's HMAC-SHA256 (Stripe's signature
 * scheme), so no npm dependency is needed.
 */
export class StripeBilling {
  private opts: StripeBillingOptions;

  constructor(opts: StripeBillingOptions) {
    this.opts = opts;
  }

  /** True when the operator has configured keys + at least one price id. */
  get enabled(): boolean {
    return !!this.opts.secretKey && !!this.opts.webhookSecret
      && Object.values(this.opts.priceIds).some(Boolean);
  }

  private fetch(url: string, init: RequestInit): Promise<Response> {
    const impl = this.opts.fetchImpl || fetch;
    return impl(url, init);
  }

  /** Create a Stripe Checkout Session for a plan tier; returns the hosted URL. */
  async createCheckoutSession(tier: string, tenantId?: string): Promise<{ url: string; sessionId: string }> {
    if (!this.enabled) {
      throw new Error('Stripe billing not configured — set billing.secretKey, billing.webhookSecret and billing.priceIds in config');
    }
    const priceId = this.opts.priceIds[tier];
    if (!priceId) throw new Error(`No Stripe price configured for plan: ${tier}`);

    const base = (this.opts.publicUrl || 'http://127.0.0.1:8787').replace(/\/+$/, '');
    const body = new URLSearchParams({
      mode: 'subscription',
      'line_items[0][price]': priceId,
      'line_items[0][quantity]': '1',
      'metadata[tier]': tier,
      'success_url': `${base}/billing/success?session_id={CHECKOUT_SESSION_ID}`,
    });
    if (tenantId) body.set('metadata[tenant]', tenantId);
    body.set('cancel_url', `${base}/billing/cancel`);

    const res = await this.fetch(`${STRIPE_API}/checkout/sessions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.opts.secretKey}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
    });
    const json = (await res.json()) as any;
    if (!res.ok) {
      throw new Error(`Stripe checkout failed (${res.status}): ${json?.error?.message ?? JSON.stringify(json)}`);
    }
    if (!json.url) throw new Error('Stripe did not return a checkout URL');
    return { url: json.url, sessionId: json.id };
  }

  /**
   * Verify a Stripe webhook signature header (`t=...,v1=...`). Computes the
   * HMAC-SHA256 of `<timestamp>.<rawBody>` with the webhook secret and rejects
   * timestamps older than 5 minutes (replay protection).
   */
  verifySignature(rawBody: string, signatureHeader: string): boolean {
    if (!this.opts.webhookSecret || !signatureHeader) return false;
    const parts = new Map<string, string>();
    for (const item of signatureHeader.split(',')) {
      const i = item.indexOf('=');
      if (i > 0) parts.set(item.slice(0, i), item.slice(i + 1));
    }
    const timestamp = parts.get('t');
    const expected = parts.get('v1');
    if (!timestamp || !expected) return false;
    if (Math.abs(Date.now() / 1000 - Number(timestamp)) > MAX_WEBHOOK_AGE_MS / 1000) return false;

    const digest = crypto.createHmac('sha256', this.opts.webhookSecret)
      .update(`${timestamp}.${rawBody}`)
      .digest('hex');
    const a = Buffer.from(digest);
    const b = Buffer.from(expected);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  /**
   * Handle an incoming webhook: verify the signature, then on
   * `checkout.session.completed` activate the paid plan via onPlanPaid(tier).
   */
  async handleWebhook(rawBody: string, signatureHeader: string): Promise<{ event: string; activated?: string; tenant?: string; provisioned?: boolean; tornDown?: boolean }> {
    if (!this.verifySignature(rawBody, signatureHeader)) {
      throw new Error('Invalid Stripe webhook signature');
    }
    const event = JSON.parse(rawBody) as any;
    const eventType = event?.type ?? 'unknown';

    // ── Checkout completed → activate plan + provision cloud VPS ──
    if (eventType === 'checkout.session.completed') {
      const session = event.data?.object;
      const tier = session?.metadata?.tier || session?.client_reference_id;
      const tenant = session?.metadata?.tenant;
      const customerId = session?.customer;
      const subscriptionId = session?.subscription;

      if (tier) {
        await this.opts.onPlanPaid(String(tier), tenant ? String(tenant) : undefined);
        getLogger().info(
          { tier, tenant: tenant || undefined, session: session?.id, customerId, subscriptionId },
          'Paid plan activated via Stripe webhook',
        );
        return { event: eventType, activated: String(tier), tenant: tenant ? String(tenant) : undefined, provisioned: true };
      }
    }

    // ── Subscription canceled → tear down cloud VPS ──
    if (eventType === 'customer.subscription.deleted' && this.opts.onSubscriptionCanceled) {
      const sub = event.data?.object;
      const customerId = sub?.customer;
      const subscriptionId = sub?.id;
      if (customerId && subscriptionId) {
        await this.opts.onSubscriptionCanceled(String(customerId), String(subscriptionId));
        getLogger().info({ customerId, subscriptionId }, 'Subscription canceled — cloud VPS teardown triggered');
        return { event: eventType, tornDown: true };
      }
    }

    // ── Invoice payment failed → warn but don't tear down yet (give grace period) ──
    if (eventType === 'invoice.payment_failed') {
      const invoice = event.data?.object;
      const customerId = invoice?.customer;
      getLogger().warn({ customerId, attempt: invoice?.attempt_count }, 'Invoice payment failed — grace period active');
      return { event: eventType };
    }

    return { event: eventType };
  }
}
