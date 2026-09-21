# Cloud Setup — Zero-Cost-Until-Paid Strategy

This doc explains how to set up Umbra OS cloud provisioning so that **you pay nothing**
until a user actually pays. The infra cost is passed to the user's subscription.

## How It Works

```
User pays (Stripe) → Webhook fires → Umbra provisions a Hetzner VPS →
User gets a 4GB (Pro) or 8GB (Ultimate) server → VPS destroyed on cancel
```

**You never pay for a server until a user pays.** The VPS only exists while
their subscription is active.

## Pricing Matrix

| Plan | Server Type | vCPU | RAM | Disk | Infra Cost | User Pays | Your Margin |
|------|------------|------|-----|------|-----------|-----------|-------------|
| Pro | cx22 | 2 | 4 GB | 40 GB | ~€3.79/mo | ~€19/mo | ~€15/mo |
| Ultimate | cx33 | 2 | 8 GB | 80 GB | ~€6.49/mo | ~€38/mo | ~€31/mo |

Plus ~€5/mo (Pro) or ~€10/mo (Ultimate) AI token budget via OpenRouter.

## Prerequisites

### 1. Hetzner Cloud Account

1. Sign up at [cloud.hetzner.com](https://cloud.hetzner.com) (free, no credit card for API)
2. Go to **Security → API Tokens** → Create a new token (Read & Write)
3. Copy the token

### 2. Upload an SSH Key

1. In Hetzner Cloud Console, go to **Security → SSH Keys**
2. Upload your public key (`~/.ssh/id_ed25519.pub` or generate one)
3. Name it `umbra-cloud` (or whatever you set in config)

```bash
# Generate a key if you don't have one:
ssh-keygen -t ed25519 -f ~/.ssh/umbra-cloud -N ""
```

### 3. Build + Push the Docker Image

```bash
# From the umbra project root:
docker build -t umbra-os:latest .
docker tag umbra-os:latest your-registry/umbra-os:latest
docker push your-registry/umbra-os:latest
```

### 4. Configure Umbra

Edit `~/.umbra/config.json`:

```json
{
  "cloud": {
    "enabled": true,
    "hetznerApiToken": "your-hetzner-api-token",
    "sshKeyName": "umbra-cloud",
    "location": "nbg1",
    "umbraImage": "your-registry/umbra-os:latest",
    "publicUrl": "https://umbra.yourdomain.com"
  },
  "billing": {
    "secretKey": "sk_live_...",
    "webhookSecret": "whsec_...",
    "priceIds": {
      "pro": "price_pro_monthly_id",
      "ultimate": "price_ultimate_monthly_id"
    },
    "publicUrl": "https://umbra.yourdomain.com"
  }
}
```

Or use environment variables:

```bash
export HETZNER_API_TOKEN=your-token
export OPENROUTER_API_KEY=your-openrouter-key
export STRIPE_SECRET_KEY=sk_live_...
export STRIPE_WEBHOOK_SECRET=whsec_...
```

### 5. Set Up Stripe

1. Create a Stripe account at [stripe.com](https://stripe.com)
2. Create two products + prices:
   - **Umbra Pro** — €19/month recurring
   - **Umbra Ultimate** — €38/month recurring
3. Copy the price IDs (e.g., `price_1ABC...`)
4. Create a webhook endpoint pointing to:
   ```
   https://yourdomain.com/api/stripe-webhook
   ```
5. Select events: `checkout.session.completed`, `customer.subscription.deleted`, `invoice.payment_failed`
6. Copy the webhook signing secret

## The Flow (Step by Step)

### When a User Pays

1. User clicks "Get Pro" in the web app
2. Umbra creates a Stripe Checkout Session (`GET /api/billing/checkout?tier=pro`)
3. User completes payment on Stripe's hosted page
4. Stripe fires `checkout.session.completed` webhook to `/api/stripe-webhook`
5. Umbra verifies the signature, then:
   - Creates/updates the user account
   - Activates the plan (assigns token budget)
   - Initializes the virtual wallet (€5 for Pro, €10 for Ultimate)
   - Calls `HetznerProvisioner.provision(userId, tier)`
   - Hetzner creates a cx22 (Pro) or cx33 (Ultimate) server
   - cloud-init installs Docker + pulls the Umbra image + runs it
   - Server IP is linked to the user's account
6. The user's cloud instance is live at `http://<server-ip>:8787`

### When a User Cancels

1. Stripe fires `customer.subscription.deleted` webhook
2. Umbra looks up the user's Hetzner server ID from the database
3. Calls `HetznerProvisioner.teardown(serverId)`
4. Hetzner destroys the server — you stop paying immediately

## Free-Tier (No Cloud)

Free users get **no cloud server**. They run Umbra locally on their own PC.
The `cloudAccess: false` flag in the plan definition enforces this.

## What Runs on the Cloud Box

The cloud instance runs Umbra in **headless mode** (`UMBRA_ROLE=cloud`):

- API server (port 8787) — the web app connects here
- Agent loop — plans + executes tasks via OpenRouter
- MCP registry + router — vault-backed connectors
- Voice stack (optional, needs setup)
- Device hub (port 8788) — phone connects here

**Does NOT run** (desktop-only):
- Screen reader / OCR
- Preview streamer
- Command HUD
- Browser control (Desktop 2)
- Native input

## Monitoring

List all managed servers:
```bash
curl -H "Authorization: Bearer your-api-key" http://localhost:8787/api/status
```

Check Hetzner servers directly:
```bash
curl -H "Authorization: Bearer your-hetzner-token" https://api.hetzner.cloud/v1/servers?label_selector=umbra=true
```

## Cost Optimization

- **cx22** (Pro) is the cheapest ARM64 box at €3.79/mo — enough for Umbra headless
- **cx33** (Ultimate) gives 2x RAM for heavier agent workloads
- Use **nbg1** (Nuremberg) or **fsn1** (Falkenstein) for lowest latency to OpenRouter
- Umbra is installed directly via cloud-init (Node.js + git clone) — no Docker needed
- The VPS is a thin relay: it receives requests, routes them to OpenRouter, and manages SQLite. ~300 MB RAM idle

## Troubleshooting

**Server not provisioning:**
- Check Hetzner API token is valid (Security → API Tokens)
- Ensure the SSH key name matches exactly
- Check Umbra logs for `Hetzner provisioning failed`

**Webhook not firing:**
- Verify the webhook URL in Stripe Dashboard
- Check the webhook signing secret matches your config
- Use `stripe listen --forward-to localhost:8787/api/stripe-webhook` for local testing

**Server destroyed but still showing:**
- Run `GET /api/status` to check Hetzner server list
- The teardown is async — may take a few seconds

## Hybrid Execution Model

Umbra runs a **cloud-first + device-parallel** dispatch model:

```
Phone/Web sends task
         │
         ▼
   Cloud VPS (always runs the task)
         │
         ├──► TaskSyncBridge broadcasts to all connected devices
         │
         └──► If desktop is online, also relays task to execute in parallel
```

### How dispatch works

| Target | Behavior |
|--------|----------|
| `auto` (default) | Cloud runs the task **AND** relays to every online desktop (parallel execution) |
| `cloud` / `local` | Cloud runs the task only |
| `deviceId` | Routes to that specific device only (no cloud execution) |

### Why this model

- **Reliability**: The cloud VPS is always on. If the user's desktop is off, asleep, or on a different network, the task still runs.
- **Speed**: When the desktop is online, it executes in parallel — the user gets results faster.
- **Consistency**: Task lifecycle events (created → started → progress → completed) broadcast to all devices via `TaskSyncBridge`, so the phone, desktop, and web dashboard all see the same status.
- **Fallback**: If the desktop is slow or offline, the cloud handles it alone — no user-facing errors.

### Resource usage on the VPS

The VPS is a thin relay (~300 MB RAM idle, ~500 MB under load). LLM inference happens on OpenRouter's servers, not the VPS. The VPS just:
1. Receives HTTP/WebSocket requests
2. Routes to the right model via SmartRoutingMatrix
3. Forwards to OpenRouter (network I/O)
4. Returns the response
5. Manages SQLite for users/tasks/memory
