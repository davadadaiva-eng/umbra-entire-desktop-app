/**
 * HetznerProvisioner — on-demand VPS creation via Hetzner Cloud API.
 *
 * When a user pays via Stripe, this spins up their plan's box
 * (pro → CX33 €6.70, advanced/ultimate → CX43 €10, enterprise → CPX42 €29.99),
 * installs Umbra OS, and returns the access details.
 * On subscription cancel, the box is destroyed so the operator stops paying.
 *
 * Server types + costs live in ../metering/pricing (CLOUD_SPECS) —
 * the single source of truth. Flow:
 *   1. Stripe webhook fires checkout.session.completed
 *   2. Umbra calls provision(userId, tier)
 *   3. Hetzner creates server, waits for SSH, runs cloud-init
 *   4. Returns { ip, sshPort, sshKey, status }
 *   5. On cancel: teardown(serverId) deletes the box
 *
 * Zero cost until a user actually pays — the VPS only exists while subscribed.
 */
import { getLogger } from '../Logger';
import { cloudSpecFor } from '../metering/pricing';

export interface HetznerConfig {
  /** Hetzner Cloud API token (from cloud.hetzner.com/account/api-tokens). */
  apiToken: string;
  /** SSH public key name in Hetzner (must be pre-uploaded). */
  sshKeyName: string;
  /** Hetzner location (e.g. 'fsn1', 'nbg1', 'hel1'). Default: 'fsn1' (Falkenstein). */
  location?: string;
  /** Server type for each tier. Default: 'cax11' (2 vCPU ARM, 4 GB, ~€4.49/mo). */
  serverType?: string;
  /** Base image name/id (Ubuntu 22.04 ARM64). */
  image?: string;
  /** Your Umbra OS Docker image name (must be pre-built and pushed). */
  umbraImage?: string;
  /** Public URL base for the Umbra instance (e.g. 'https://umbra.yourdomain.com'). */
  publicUrl?: string;
  /** Inject fetch for tests. */
  fetchImpl?: typeof fetch;
}

export interface ProvisionResult {
  serverId: number;
  ip: string;
  sshPort: number;
  status: 'provisioning' | 'running' | 'error';
  accessUrl: string;
  sshCommand: string;
  estimatedCost: string;
  error?: string;
}

export interface ServerInfo {
  id: number;
  name: string;
  ip: string;
  status: string;
  createdAt: Date;
  serverType: string;
}

const HETZNER_API = 'https://api.hetzner.cloud/v1';

export class HetznerProvisioner {
  private config: HetznerConfig;

  constructor(config: HetznerConfig) {
    this.config = {
      location: 'nbg1',
      serverType: 'cx22',
      image: 'docker-ce',
      umbraImage: 'umbra-os:latest',
      ...config,
    };
  }

  get enabled(): boolean {
    return !!this.config.apiToken && !!this.config.sshKeyName;
  }

  private async api(method: string, path: string, body?: any): Promise<any> {
    const impl = this.config.fetchImpl || fetch;
    const opts: RequestInit = {
      method,
      headers: {
        Authorization: `Bearer ${this.config.apiToken}`,
        'Content-Type': body ? 'application/json' : undefined,
      } as Record<string, string>,
    };
    if (body) opts.body = JSON.stringify(body);
    const res = await impl(`${HETZNER_API}${path}`, opts);
    const json: any = await res.json();
    if (!res.ok) {
      throw new Error(`Hetzner API ${res.status}: ${json?.error?.message ?? JSON.stringify(json)}`);
    }
    return json;
  }

  /**
   * Provision a new VPS for a paying user.
   * Server type comes from pricing.ts (CLOUD_SPECS): pro → CX33 (€6.70),
   * advanced/ultimate → CX43 (€10), enterprise → CPX42 (€29.99).
   */
  /**
   * JIT provisioning per plan: each tier gets its own box.
   * Legacy tiers (free/ultimate) map to their plan equivalents.
   */
  async provision(userId: string, tier: string): Promise<ProvisionResult> {
    if (!this.enabled) {
      return { serverId: 0, ip: '', sshPort: 22, status: 'error', accessUrl: '', sshCommand: '', estimatedCost: '', error: 'Hetzner not configured' };
    }

    const spec = cloudSpecFor(tier);
    const normalizedTier = tier === 'advanced' ? 'advanced' : tier === 'pro' ? 'pro' : tier === 'ultimate' ? 'ultimate' : tier === 'enterprise' ? 'enterprise' : tier;
    const serverName = `umbra-${userId.slice(0, 8)}-${normalizedTier}`;
    const serverType = spec.type;
    const estimatedCost = spec.label;

    getLogger().info({ userId, tier, serverName, serverType }, 'Provisioning Hetzner VPS');

    // Cloud-init script: install Docker, pull Umbra image, run it
    const cloudInit = this.buildCloudInit(userId, tier);

    try {
      const result = await this.api('POST', '/servers', {
        name: serverName,
        server_type: serverType,
        location: this.config.location,
        image: this.config.image,
        ssh_keys: [this.config.sshKeyName],
        user_data: cloudInit,
        labels: {
          umbra: 'true',
          'umbra-user': userId,
          'umbra-tier': tier,
          'umbra-managed': 'true',
        },
        networks: [],
        public_net: { enable_ipv4: true, enable_ipv6: false },
      });

      const server = result.server;
      const ip = server.public_net?.ipv4?.ip || '';

      getLogger().info({ serverId: server.id, ip, serverName }, 'Hetzner VPS created');

      return {
        serverId: server.id,
        ip,
        sshPort: 22,
        status: 'provisioning',
        accessUrl: ip ? `http://${ip}:8787` : '',
        sshCommand: ip ? `ssh root@${ip}` : '',
        estimatedCost,
      };
    } catch (err: any) {
      getLogger().error({ err: err.message, userId }, 'Hetzner provisioning failed');
      return { serverId: 0, ip: '', sshPort: 22, status: 'error', accessUrl: '', sshCommand: '', estimatedCost, error: err.message };
    }
  }

  /**
   * Destroy a VPS when the user cancels their subscription.
   */
  async teardown(serverId: number): Promise<boolean> {
    if (!this.enabled || !serverId) return false;
    try {
      await this.api('DELETE', `/servers/${serverId}`);
      getLogger().info({ serverId }, 'Hetzner VPS destroyed');
      return true;
    } catch (err: any) {
      getLogger().error({ err: err.message, serverId }, 'Hetzner teardown failed');
      return false;
    }
  }

  /**
   * Find all Umbra-managed servers (for admin visibility).
   */
  async listUmbraServers(): Promise<ServerInfo[]> {
    if (!this.enabled) return [];
    try {
      const result = await this.api('GET', '/servers?label_selector=umbra=true');
      return (result.servers || []).map((s: any) => ({
        id: s.id,
        name: s.name,
        ip: s.public_net?.ipv4?.ip || '',
        status: s.status,
        createdAt: new Date(s.created),
        serverType: s.server_type.name,
      }));
    } catch {
      return [];
    }
  }

  /**
   * Check if a server is reachable (for health checks).
   */
  async serverStatus(serverId: number): Promise<string> {
    if (!this.enabled || !serverId) return 'unknown';
    try {
      const result = await this.api('GET', `/servers/${serverId}`);
      return result.server?.status || 'unknown';
    } catch {
      return 'unknown';
    }
  }

  /**
   * Build the cloud-init script that installs Node.js + Umbra on first boot.
   * No Docker — just Node, npm, git, and the app runs directly.
   */
  private buildCloudInit(userId: string, tier: string): string {
    const publicUrl = this.config.publicUrl || '';
    const openrouterKey = process.env.OPENROUTER_API_KEY || '';
    // Git repo to clone (set this to your private repo URL)
    const repoUrl = process.env.UMBRA_REPO_URL || 'https://github.com/youruser/umbra.git';

    return `#cloud-config
# Umbra OS cloud-init — installs Node.js + app for user ${userId} (tier: ${tier})
package_update: true
packages:
  - curl
  - git
  - build-essential

runcmd:
  # Install Node.js 20.x (LTS)
  - curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  - apt-get install -y nodejs

  # Create umbra user
  - useradd -m -s /bin/bash umbra || true
  - mkdir -p /home/umbra/.umbra
  - chown -R umbra:umbra /home/umbra/.umbra

  # Write Umbra config
  - |
    cat > /home/umbra/.umbra/config.json << 'UMBRA_CONFIG'
    {
      "provider": "openai-compatible",
      "openrouterApiKey": "${openrouterKey}",
      "openaiCompatible": {
        "apiKey": "${openrouterKey}",
        "endpoint": "https://openrouter.ai/api/v1"
      },
      "autoApprove": true,
      "tier": "${tier}",
      "hermes": { "enabled": true, "bin": "", "taskTimeoutMs": 300000, "autoDelegate": true }
    }
    UMBRA_CONFIG
  - chown umbra:umbra /home/umbra/.umbra/config.json

  # Clone and set up Umbra
  - su - umbra -c "git clone ${repoUrl} /home/umbra/umbra"
  - su - umbra -c "cd /home/umbra/umbra && npm install --production"
  - su - umbra -c "cd /home/umbra/umbra && npm run build"

  # Create systemd service so Umbra starts on boot and restarts on crash
  - |
    cat > /etc/systemd/system/umbra.service << 'UNIT'
    [Unit]
    Description=Umbra OS
    After=network.target

    [Service]
    Type=simple
    User=umbra
    WorkingDirectory=/home/umbra/umbra
    Environment=UMBRA_HEADLESS=1
    Environment=UMBRA_ROLE=cloud
    Environment=UMBRA_CONSENT_AUTOGRANT=1
    Environment=UMBRA_PUBLIC_URL=${publicUrl}
    Environment=OPENROUTER_API_KEY=${openrouterKey}
    ExecStart=/usr/bin/node dist/index.js
    Restart=always
    RestartSec=5

    [Install]
    WantedBy=multi-user.target
    UNIT
  - systemctl daemon-reload
  - systemctl enable umbra
  - systemctl start umbra

  # Log completion
  - echo "Umbra OS deployed for user ${userId} (tier ${tier})" > /home/umbra/.umbra/.deployed
  - date >> /home/umbra/.umbra/.deployed

final_message: "Umbra OS ready for user ${userId}"
`;
  }
}
