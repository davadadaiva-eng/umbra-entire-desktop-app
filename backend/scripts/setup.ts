/**
 * setup.ts — first-run Umbra setup. Collects the LLM provider, API key,
 * model names, and plan tier, writes them into ~/.umbra/config.json, and runs
 * a small live validation call so you know immediately whether the key works.
 *
 *   npm run setup                     # interactive
 *   npm run setup -- --provider openai --api-key sk-... --tier pro
 *   npm run setup -- --provider openai-compatible --endpoint https://... --api-key ... --model-reasoning gpt-4o --model-fast gpt-4o-mini
 *   npm run setup -- --openrouter-key sk-or-... --tier pro   # one key maps every model
 *   npm run setup -- --keys-file ./umbra-keys.json          # all keys from one JSON or .env file
 *
 * Keys are stored in the local, git-ignored config (or can be moved to the
 * CredentialVault). Nothing is sent anywhere except the provider's own
 * validation endpoint.
 */
import * as fs from 'fs';
import * as readline from 'readline';
import * as path from 'path';
import { ConfigManager } from '../src/config/ConfigManager';
import { CredentialVault } from '../src/core/vault/CredentialVault';
import { getStableHwid } from '../src/native/win32/HardwareId';
import { DEFAULT_ROUTING } from '../src/core/metering/ModelRouter';
import { ModelProvider, PlanTier, RoutingConfig, RoutingTier } from '../src/types';

const PROVIDERS: ModelProvider[] = ['ollama', 'openai', 'anthropic', 'openai-compatible'];

const PROVIDER_MODELS: Record<string, { reasoning: string; vision: string; fast: string }> = {
  ollama: { reasoning: 'qwen2.5:14b', vision: 'qwen2.5-vl:7b', fast: 'qwen2.5:7b' },
  openai: { reasoning: 'gpt-4o', vision: 'gpt-4o', fast: 'gpt-4o-mini' },
  anthropic: { reasoning: 'claude-sonnet-4-20250514', vision: 'claude-sonnet-4-20250514', fast: 'claude-haiku-4-5-20251001' },
  'openai-compatible': { reasoning: '', vision: '', fast: '' },
};

/** OpenRouter — one key can fund every model slot (OpenAI-compatible). */
const OPENROUTER_ENDPOINT = 'https://openrouter.ai/api/v1';

/** Real model ids + pricing (USD per 1M tokens) for each routing slot. */
const OPENROUTER_SLOTS: Record<RoutingTier, { model: string; inputPerM: number; cacheHitPerM: number; outputPerM: number }> = {
  free: { model: 'meta-llama/llama-3.1-8b-instruct:free', inputPerM: 0, cacheHitPerM: 0, outputPerM: 0 },
  fast: { model: 'deepseek/deepseek-chat', inputPerM: 0.27, cacheHitPerM: 0.07, outputPerM: 1.1 },
  reasoning: { model: 'deepseek/deepseek-r1', inputPerM: 0.55, cacheHitPerM: 0.14, outputPerM: 2.19 },
  frontend: { model: 'meta-llama/llama-3.3-70b-instruct', inputPerM: 0.23, cacheHitPerM: 0.04, outputPerM: 0.4 },
  difficult: { model: 'anthropic/claude-3.5-sonnet', inputPerM: 3, cacheHitPerM: 0.3, outputPerM: 15 },
};

/** Point every routing slot at OpenRouter with a real model id + pricing. */
function applyOpenRouterSlots(routing: RoutingConfig): void {
  for (const tier of Object.keys(OPENROUTER_SLOTS) as RoutingTier[]) {
    const slot = routing[tier];
    const map = OPENROUTER_SLOTS[tier];
    slot.provider = 'openai-compatible';
    slot.endpoint = OPENROUTER_ENDPOINT;
    slot.model = map.model;
    slot.inputPerM = map.inputPerM;
    slot.cacheHitPerM = map.cacheHitPerM;
    slot.outputPerM = map.outputPerM;
  }
}

/** Live-validate an OpenRouter key and report its credit state. */
async function validateOpenRouter(key: string): Promise<{ ok: boolean; message: string }> {
  try {
    const res = await fetch(`${OPENROUTER_ENDPOINT}/key`, { headers: { Authorization: `Bearer ${key}` } });
    if (!res.ok) return { ok: false, message: `OpenRouter returned HTTP ${res.status}` };
    const j: any = await res.json();
    const d = j?.data ?? {};
    const parts: string[] = [];
    if (d.limit != null) parts.push(`$${Number(d.limit).toFixed(2)} credit limit`);
    if (d.limit_remaining != null) parts.push(`$${Number(d.limit_remaining).toFixed(2)} remaining`);
    parts.push(`$${Number(d.usage_monthly ?? 0).toFixed(2)} used this month`);
    return { ok: true, message: `OpenRouter key valid (${parts.join(', ')})` };
  } catch (err: any) {
    return { ok: false, message: err?.message || 'validation failed' };
  }
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < process.argv.length) return process.argv[i + 1];
  return undefined;
}

const hasFlag = (name: string): boolean => process.argv.includes(`--${name}`);

/**
 * Load a keys file (--keys-file). Accepts either JSON (flat or one level of
 * nesting, any casing — see umbra-keys.example.json) or a .env style file of
 * KEY=VALUE lines. Values are returned keyed exactly as written.
 */
function loadKeysFile(file: string): Record<string, string> {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err: any) {
    throw new Error(`Cannot read keys file ${file}: ${err?.message || err}`);
  }
  const out: Record<string, string> = {};
  const trimmed = raw.trim();
  if (!trimmed) return out;
  if (trimmed.startsWith('{')) {
    let j: any;
    try {
      j = JSON.parse(raw);
    } catch (err: any) {
      throw new Error(`Keys file ${file} is not valid JSON: ${err?.message || err}`);
    }
    for (const [k, v] of Object.entries(j)) {
      if (typeof v === 'string' && v) out[k] = v;
      else if (v && typeof v === 'object') {
        // one level of nesting: { telnyx: { key, from } } → 'telnyx.key'
        for (const [k2, v2] of Object.entries(v as Record<string, unknown>)) {
          if (typeof v2 === 'string' && v2) out[`${k}.${k2}`] = v2;
        }
      }
    }
  } else {
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (!m) continue;
      const val = m[2].replace(/^(["'])(.*)\1$/, '$2');
      if (val) out[m[1]] = val;
    }
  }
  return out;
}

/** Case-/separator-insensitive lookup: 'openRouterKey' == 'OPENROUTER_API_KEY' == 'openrouter.key'. */
const fileVal = (vals: Record<string, string>, ...names: string[]): string | undefined => {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  for (const [k, v] of Object.entries(vals)) if (names.some(n => norm(n) === norm(k))) return v;
  return undefined;
};

function ask(rl: readline.Interface, question: string, def?: string): Promise<string> {
  return new Promise(resolve => {
    rl.question(`${question}${def ? ` [${def}]` : ''} `, ans => resolve(ans.trim() || def || ''));
  });
}

async function validate(cfg: { provider: ModelProvider; models: { fast: string }; ollama?: { endpoint?: string }; openai?: { apiKey?: string }; anthropic?: { apiKey?: string }; openaiCompatible?: { endpoint: string; apiKey?: string } }): Promise<{ ok: boolean; message: string }> {
  const p = cfg.provider;
  try {
    if (p === 'ollama') {
      const ep = (cfg.ollama?.endpoint || 'http://localhost:11434').replace(/\/$/, '');
      const res = await fetch(`${ep}/api/tags`);
      return { ok: res.ok, message: res.ok ? `Ollama reachable at ${ep}` : `Ollama returned HTTP ${res.status}` };
    }
    if (p === 'openai') {
      const key = cfg.openai?.apiKey || '';
      if (!key) return { ok: false, message: 'No API key set' };
      const res = await fetch('https://api.openai.com/v1/models', { headers: { Authorization: `Bearer ${key}` } });
      return { ok: res.ok, message: res.ok ? 'OpenAI key valid' : `OpenAI returned HTTP ${res.status}` };
    }
    if (p === 'anthropic') {
      const key = cfg.anthropic?.apiKey || '';
      if (!key) return { ok: false, message: 'No API key set' };
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: cfg.models.fast, max_tokens: 8, messages: [{ role: 'user', content: 'ok' }] }),
      });
      return { ok: res.ok, message: res.ok ? 'Anthropic key valid' : `Anthropic returned HTTP ${res.status}` };
    }
    if (p === 'openai-compatible') {
      const ep = (cfg.openaiCompatible?.endpoint || '').replace(/\/$/, '');
      const key = cfg.openaiCompatible?.apiKey || '';
      if (!ep) return { ok: false, message: 'No endpoint set' };
      const res = await fetch(`${ep}/models`, { headers: key ? { Authorization: `Bearer ${key}` } : {} });
      return { ok: res.ok, message: res.ok ? 'Compatible endpoint reachable' : `Endpoint returned HTTP ${res.status}` };
    }
    return { ok: false, message: `Unknown provider: ${p}` };
  } catch (err: any) {
    return { ok: false, message: err?.message || 'validation failed' };
  }
}

async function main(): Promise<void> {
  const dataDir = process.env.UMBRA_DATA_DIR || path.join(process.env.USERPROFILE || '~', '.umbra');
  const cm = new ConfigManager(dataDir);
  await cm.initialize();

  const nonInteractive = hasFlag('non-interactive') || !process.stdin.isTTY;
  const rl = nonInteractive ? null : readline.createInterface({ input: process.stdin, output: process.stdout });

  const envKeys: Record<ModelProvider, string | undefined> = {
    ollama: undefined,
    openai: process.env.OPENAI_API_KEY,
    anthropic: process.env.ANTHROPIC_API_KEY,
    'openai-compatible': process.env.OPENAI_API_KEY,
  };

  // ── Keys file (--keys-file: JSON or .env) ────────────────────
  const keysFilePath = arg('keys-file') || arg('keys');
  const fileKeys = keysFilePath ? loadKeysFile(keysFilePath) : {};
  const fv = (...names: string[]) => fileVal(fileKeys, ...names);

  // ── One-OpenRouter-key convenience mode ─────────────────────
  const openRouterRequested = hasFlag('openrouter') || !!arg('openrouter-key') || !!process.env.OPENROUTER_API_KEY
    || !!fv('openrouter', 'openrouterkey', 'OPENROUTER_API_KEY');
  const openRouterKey = arg('openrouter-key') || process.env.OPENROUTER_API_KEY
    || fv('openrouter', 'openrouterkey', 'OPENROUTER_API_KEY')
    || (openRouterRequested && rl ? await ask(rl, 'OpenRouter API key (one key funds every model slot)', '') : '');

  // ── Provider ──────────────────────────────────────────────
  let provider: ModelProvider;
  let endpoint: string;
  let apiKey: string;
  let modelReasoning: string;
  let modelVision: string;
  let modelFast: string;

  if (openRouterKey) {
    provider = 'openai-compatible';
    endpoint = OPENROUTER_ENDPOINT;
    apiKey = openRouterKey;
    modelReasoning = 'deepseek/deepseek-r1';
    modelVision = 'meta-llama/llama-3.3-70b-instruct';
    modelFast = 'deepseek/deepseek-chat';
  } else {
    provider = (arg('provider') || process.env.UMBRA_PROVIDER || fv('provider', 'UMBRA_PROVIDER') || '') as ModelProvider;
    if (!PROVIDERS.includes(provider)) {
      provider = rl
        ? (await ask(rl, `Provider (${PROVIDERS.join('/')})`, 'ollama')) as ModelProvider
        : 'ollama';
    }
    if (!PROVIDERS.includes(provider)) throw new Error(`Unknown provider: ${provider}`);

    const defaults = PROVIDER_MODELS[provider];
    endpoint = arg('endpoint') || fv('endpoint', 'OLLAMA_ENDPOINT', 'ENDPOINT')
      || (provider === 'ollama' ? 'http://localhost:11434' : '');
    const providerFileKeys: Record<ModelProvider, string[]> = {
      ollama: ['ollama'],
      openai: ['openai', 'OPENAI_API_KEY'],
      anthropic: ['anthropic', 'ANTHROPIC_API_KEY'],
      'openai-compatible': ['openai', 'openaicompatible', 'OPENAI_API_KEY'],
    };
    apiKey = arg('api-key') || envKeys[provider] || fv('apikey', 'API_KEY', ...providerFileKeys[provider])
      || (rl ? await ask(rl, 'API key (optional for ollama)', '') : '');
    modelReasoning = arg('model-reasoning') || fv('modelreasoning', 'MODEL_REASONING')
      || (rl ? await ask(rl, 'Reasoning model', defaults.reasoning) : defaults.reasoning);
    modelVision = arg('model-vision') || fv('modelvision', 'MODEL_VISION')
      || (rl ? await ask(rl, 'Vision model', defaults.vision) : defaults.vision);
    modelFast = arg('model-fast') || fv('modelfast', 'MODEL_FAST')
      || (rl ? await ask(rl, 'Fast model', defaults.fast) : defaults.fast);
  }
  const tier = (arg('tier') || fv('tier', 'UMBRA_TIER') || 'free') as PlanTier;

  // ── Telco (Telnyx) — optional ───────────────────────────
  const telnyxKey = arg('telnyx-key') || process.env.TELNYX_API_KEY
    || fv('telnyxkey', 'telnyx', 'TELNYX_API_KEY') || (rl ? await ask(rl, 'Telnyx API key (optional, Enter to skip)', '') : '');
  const telnyxFrom = arg('telnyx-from') || fv('telnyxfrom', 'TELNYX_FROM', 'fromnumber')
    || (telnyxKey && rl ? await ask(rl, 'Telnyx from-number (E.164, e.g. +1234567890)', '') : '');
  const telnyxProfile = arg('telnyx-profile') || fv('telnyxprofile', 'TELNYX_MESSAGING_PROFILE', 'messagingprofileid') || '';

  // ── Billing (Stripe) — optional ──────────────────────────
  const stripeKey = arg('stripe-key') || process.env.STRIPE_SECRET_KEY
    || fv('stripesecretkey', 'stripe', 'STRIPE_SECRET_KEY') || (rl ? await ask(rl, 'Stripe secret key (sk_..., optional, Enter to skip)', '') : '');
  const stripeWebhook = arg('stripe-webhook-secret') || process.env.STRIPE_WEBHOOK_SECRET
    || fv('stripewebhooksecret', 'STRIPE_WEBHOOK_SECRET', 'webhooksecret')
    || (stripeKey && rl ? await ask(rl, 'Stripe webhook secret (whsec_..., from the Stripe dashboard)', '') : '');
  const stripePricePro = arg('stripe-price-pro') || process.env.STRIPE_PRICE_PRO
    || fv('stripepricepro', 'STRIPE_PRICE_PRO', 'pricepro') || (stripeKey && rl ? await ask(rl, 'Stripe price id for Pro (price_...)', '') : '');
  const stripePriceUltimate = arg('stripe-price-ultimate') || process.env.STRIPE_PRICE_ULTIMATE
    || fv('stripepriceultimate', 'STRIPE_PRICE_ULTIMATE', 'priceultimate')
    || (stripeKey && rl ? await ask(rl, 'Stripe price id for Ultimate (price_...)', '') : '');
  const stripePriceEnterprise = arg('stripe-price-enterprise') || process.env.STRIPE_PRICE_ENTERPRISE
    || fv('stripepriceenterprise', 'STRIPE_PRICE_ENTERPRISE', 'priceenterprise')
    || (stripeKey && rl ? await ask(rl, 'Stripe price id for Enterprise (price_..., optional)', '') : '');
  const stripePublicUrl = arg('public-url') || process.env.UMBRA_PUBLIC_URL || fv('publicurl', 'UMBRA_PUBLIC_URL', 'PUBLIC_URL') || '';

  if (rl) rl.close();

  // ── Persist ───────────────────────────────────────────────
  await cm.updateProvider(provider, { reasoning: modelReasoning, vision: modelVision, fast: modelFast });
  await cm.updateProviderCredentials(provider, { endpoint: endpoint || undefined, apiKey: apiKey || undefined });
  cm.raw.plan.tier = tier;
  if (tier === 'pro' || tier === 'ultimate' || tier === 'enterprise') {
    cm.raw.plan.routing = cm.raw.plan.routing ?? { ...DEFAULT_ROUTING };
    cm.raw.plan.routing.enabled = true;
    cm.raw.plan.cloudContinuation = true;
  } else {
    cm.raw.plan.cloudContinuation = false;
  }
  if (openRouterKey) {
    cm.raw.plan.routing = cm.raw.plan.routing ?? { ...DEFAULT_ROUTING };
    applyOpenRouterSlots(cm.raw.plan.routing);
  }
  await cm.saveConfig();

  if (telnyxKey) {
    const vault = new CredentialVault({ dataDir, hwid: getStableHwid(process.env.UMBRA_HWID) });
    vault.unlock();
    const existing = vault.find('telnyx');
    vault.set({ service: 'telnyx', username: 'api-key', secret: telnyxKey }, existing?.id);
    await cm.updateTelco({ enabled: !!telnyxFrom, fromNumber: telnyxFrom || undefined, messagingProfileId: telnyxProfile || undefined });
  }

  if (stripeKey && stripeWebhook) {
    await cm.updateBilling({
      enabled: true,
      secretKey: stripeKey,
      webhookSecret: stripeWebhook,
      priceIds: {
        pro: stripePricePro || cm.raw.billing.priceIds.pro,
        ultimate: stripePriceUltimate || cm.raw.billing.priceIds.ultimate,
        enterprise: stripePriceEnterprise || cm.raw.billing.priceIds.enterprise,
      },
      publicUrl: stripePublicUrl || undefined,
    });
  }

  console.log(`\n✔ Saved config to ${dataDir}/config.json`);
  if (keysFilePath) console.log(`  keys-file : ${keysFilePath}`);
  console.log(`  provider : ${provider}`);
  console.log(`  models   : reasoning=${modelReasoning} vision=${modelVision} fast=${modelFast}`);
  console.log(`  tier     : ${tier}`);
  if (openRouterKey) console.log(`  openrouter: one key → fast/reasoning/frontend/difficult + free spillover`);
  if (telnyxKey) console.log(`  telco    : Telnyx token stored${telnyxFrom ? `, from ${telnyxFrom}` : ''}`);
  if (stripeKey && stripeWebhook) console.log(`  billing  : Stripe checkout + webhook configured`);

  // ── Live validation ───────────────────────────────────────
  console.log('\nValidating…');
  const result = openRouterKey ? await validateOpenRouter(openRouterKey) : await validate(cm.raw);
  if (result.ok) console.log(`✔ ${result.message}`);
  else console.log(`✖ ${result.message}`);

  console.log('\nNext: npm run dev   (or npm start after npm run build)');
  if (!result.ok) console.log('If the provider is unreachable, fix the key/endpoint in ~/.umbra/config.json and re-run setup.');
}

main().catch(err => {
  console.error(`Setup failed: ${err?.message || err}`);
  process.exit(1);
});
