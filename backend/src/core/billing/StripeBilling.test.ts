import * as crypto from 'crypto';
import { StripeBilling } from './StripeBilling';

const SECRET = 'sk_test_dummy';
const WEBHOOK_SECRET = 'whsec_dummy';
const PRICE_IDS = { pro: 'price_pro', ultimate: 'price_ultimate', enterprise: 'price_enterprise' };

/** Sign a raw body exactly like Stripe does: `t=<ts>,v1=<hmac>`. */
function sign(rawBody: string, secret = WEBHOOK_SECRET, timestampSec = Math.floor(Date.now() / 1000)): string {
  const sig = crypto.createHmac('sha256', secret).update(`${timestampSec}.${rawBody}`).digest('hex');
  return `t=${timestampSec},v1=${sig}`;
}

function makeBilling(overrides: Partial<ConstructorParameters<typeof StripeBilling>[0]> = {}) {
  const paid: string[] = [];
  const billing = new StripeBilling({
    secretKey: SECRET,
    webhookSecret: WEBHOOK_SECRET,
    priceIds: PRICE_IDS,
    publicUrl: 'https://umbra.example.com',
    onPlanPaid: async (tier: string) => { paid.push(tier); },
    ...overrides,
  });
  return { billing, paid };
}

describe('StripeBilling', () => {
  describe('enabled', () => {
    it('is false until keys + a price id are configured', () => {
      const { billing } = makeBilling({ secretKey: '', webhookSecret: '', priceIds: {} });
      expect(billing.enabled).toBe(false);
    });

    it('is true with a key, webhook secret, and at least one price', () => {
      const { billing } = makeBilling();
      expect(billing.enabled).toBe(true);
    });
  });

  describe('verifySignature', () => {
    const body = JSON.stringify({ type: 'checkout.session.completed' });

    it('accepts a correctly signed body', () => {
      const { billing } = makeBilling();
      expect(billing.verifySignature(body, sign(body))).toBe(true);
    });

    it('rejects a tampered body', () => {
      const { billing } = makeBilling();
      expect(billing.verifySignature(body + 'x', sign(body))).toBe(false);
    });

    it('rejects a signature made with the wrong secret', () => {
      const { billing } = makeBilling();
      expect(billing.verifySignature(body, sign(body, 'whsec_wrong'))).toBe(false);
    });

    it('rejects an expired timestamp (replay protection)', () => {
      const { billing } = makeBilling();
      const old = Math.floor(Date.now() / 1000) - 400;
      expect(billing.verifySignature(body, sign(body, WEBHOOK_SECRET, old))).toBe(false);
    });

    it('rejects a missing or malformed header', () => {
      const { billing } = makeBilling();
      expect(billing.verifySignature(body, '')).toBe(false);
      expect(billing.verifySignature(body, 'garbage')).toBe(false);
    });
  });

  describe('createCheckoutSession', () => {
    it('POSTs a subscription session to Stripe with tier metadata', async () => {
      let captured: RequestInit & { url: string } | null = null;
      const { billing } = makeBilling({
        fetchImpl: (async (url: any, init: any) => {
          captured = { url, ...init };
          return new Response(JSON.stringify({ id: 'cs_test_1', url: 'https://checkout.stripe.com/c/pay/cs_test_1' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }) as any,
      });

      const out = await billing.createCheckoutSession('pro');
      expect(out.url).toBe('https://checkout.stripe.com/c/pay/cs_test_1');

      const sent = (captured!.body as string);
      expect(captured!.url).toBe('https://api.stripe.com/v1/checkout/sessions');
      expect(captured!.headers).toMatchObject({ Authorization: `Bearer ${SECRET}` });
      expect(sent).toContain('mode=subscription');
      expect(sent).toContain('line_items%5B0%5D%5Bprice%5D=price_pro');
      expect(sent).toContain('metadata%5Btier%5D=pro');
      expect(sent).toContain('success_url=https%3A%2F%2Fumbra.example.com%2Fbilling%2Fsuccess%3Fsession_id%3D%7BCHECKOUT_SESSION_ID%7D');
    });

    it('throws for an unconfigured tier or missing config', async () => {
      const { billing } = makeBilling();
      await expect(billing.createCheckoutSession('free')).rejects.toThrow('No Stripe price configured');
      const unconfigured = makeBilling({ secretKey: '', webhookSecret: '' }).billing;
      await expect(unconfigured.createCheckoutSession('pro')).rejects.toThrow('not configured');
    });

    it('surfaces Stripe API errors', async () => {
      const { billing } = makeBilling({
        fetchImpl: (async () => new Response(JSON.stringify({ error: { message: 'No such price' } }), { status: 400, headers: { 'Content-Type': 'application/json' } })) as any,
      });
      await expect(billing.createCheckoutSession('pro')).rejects.toThrow('No such price');
    });
  });

  describe('handleWebhook', () => {
    it('activates the plan from metadata on checkout.session.completed', async () => {
      const { billing, paid } = makeBilling();
      const body = JSON.stringify({
        type: 'checkout.session.completed',
        data: { object: { id: 'cs_test_9', metadata: { tier: 'ultimate' } } },
      });
      const result = await billing.handleWebhook(body, sign(body));
      expect(result).toEqual({ event: 'checkout.session.completed', activated: 'ultimate', provisioned: true });
      expect(paid).toEqual(['ultimate']);
    });

    it('ignores unrelated events without activating', async () => {
      const { billing, paid } = makeBilling();
      const body = JSON.stringify({ type: 'customer.subscription.updated', data: { object: {} } });
      const result = await billing.handleWebhook(body, sign(body));
      expect(result.event).toBe('customer.subscription.updated');
      expect(paid).toEqual([]);
    });

    it('rejects an invalid signature before touching the plan', async () => {
      const { billing, paid } = makeBilling();
      const body = JSON.stringify({ type: 'checkout.session.completed', data: { object: { metadata: { tier: 'pro' } } } });
      await expect(billing.handleWebhook(body, 't=0,v1=deadbeef')).rejects.toThrow('signature');
      expect(paid).toEqual([]);
    });
  });
});
