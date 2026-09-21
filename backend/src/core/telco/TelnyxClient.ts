/**
 * TelnyxClient — telco bridge. Sends SMS and initiates voice calls through
 * the Telnyx REST API with credentials pulled from the vault. The meeting
 * agent can drop into voice mode over this channel.
 */

import { CredentialVault } from '../vault/CredentialVault';

export interface TelnyxConfig {
  apiToken?: string;
  fromNumber?: string;
  messagingProfileId?: string;
  vault?: CredentialVault;
}

export interface SmsOptions {
  to: string;
  text: string;
  from?: string;
}

export interface CallOptions {
  to: string;
  from?: string;
  /** URL of a call control application (XML/JSON). */
  connectionUrl?: string;
}

export interface TelnyxResult {
  ok: boolean;
  id?: string;
  error?: string;
}

const TELNYX_BASE = 'https://api.telnyx.com/v2';

export class TelnyxClient {
  private apiToken: string;
  private fromNumber: string;
  private messagingProfileId?: string;
  private vault?: CredentialVault;

  constructor(config: TelnyxConfig) {
    this.fromNumber = config.fromNumber ?? '';
    this.messagingProfileId = config.messagingProfileId;
    this.vault = config.vault;
    this.apiToken = config.apiToken ?? this.resolveToken();
  }

  /** Exposed for tests/telemetry — the resolved bearer token. */
  get resolvedToken(): string {
    return this.apiToken;
  }

  async sendSms(options: SmsOptions): Promise<TelnyxResult> {
    if (!this.apiToken) return { ok: false, error: 'Telnyx API token not configured' };
    const from = options.from ?? this.fromNumber;
    if (!from) return { ok: false, error: 'No from-number configured' };
    try {
      const res = await fetch(`${TELNYX_BASE}/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.apiToken}`,
        },
        body: JSON.stringify({
          from,
          to: options.to,
          text: options.text,
          messaging_profile_id: this.messagingProfileId,
        }),
      });
      if (!res.ok) return { ok: false, error: `Telnyx returned ${res.status}` };
      const body = (await res.json()) as { data?: { id?: string } };
      return { ok: true, id: body.data?.id };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async initiateCall(options: CallOptions): Promise<TelnyxResult> {
    if (!this.apiToken) return { ok: false, error: 'Telnyx API token not configured' };
    const from = options.from ?? this.fromNumber;
    if (!from) return { ok: false, error: 'No from-number configured' };
    try {
      const res = await fetch(`${TELNYX_BASE}/calls`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.apiToken}`,
        },
        body: JSON.stringify({
          from,
          to: options.to,
          connection_url: options.connectionUrl ?? 'https://example.invalid/call-control',
        }),
      });
      if (!res.ok) return { ok: false, error: `Telnyx returned ${res.status}` };
      const body = (await res.json()) as { data?: { call_control_id?: string } };
      return { ok: true, id: body.data?.call_control_id };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  private resolveToken(): string {
    if (!this.vault || !this.vault.isUnlocked) return '';
    return this.vault.find('telnyx')?.secret ?? '';
  }
}
