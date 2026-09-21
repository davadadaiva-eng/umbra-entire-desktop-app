import { VectorMemory } from '../memory/VectorMemory';
import { KnowledgeGraph } from '../../knowledge/KnowledgeGraph';
import { PrivacyGuard } from '../privacy/PrivacyGuard';
import { CredentialVault } from '../vault/CredentialVault';
import { ConsentGate } from '../agent/ConsentGate';
import { getLogger } from '../Logger';
import { eventBus } from '../EventBus';

export interface ChromeTelemetryEvent {
  type: string;
  ts?: number;
  sessionId?: string;
  tabId?: number;
  url?: string;
  title?: string;
  prevUrl?: string;
  action?: string;
  fieldCount?: number;
  hasPassword?: boolean;
  hasUsername?: boolean;
  hasValue?: boolean;
  secure?: boolean;
  httpOnly?: boolean;
  sameSite?: string;
  path?: string;
  expires?: number;
  session?: boolean;
  provider?: string;
  domainCount?: number;
  cookieCount?: number;
  scrollY?: number;
  viewportHeight?: number;
  linkCount?: number;
  formCount?: number;
  isLoginLike?: boolean;
  frameId?: number;
}

export interface CookieSnapshot {
  [domain: string]: Array<{
    name: string;
    hasValue: boolean;
    secure: boolean;
    httpOnly: boolean;
    sameSite: string;
    path: string;
    expires: number;
    session: boolean;
  }>;
}

interface ConnectorSession {
  provider: string;
  url: string;
  cookies: Array<{
    name: string;
    value: string;
    domain: string;
    path: string;
    secure: boolean;
    httpOnly: boolean;
    sameSite: string;
    expirationDate?: number;
    session: boolean;
  }>;
  timestamp: number;
}

interface ChromeExtensionBridgeConfig {
  dataDir: string;
}

/**
 * Receives batched telemetry from the Umbra Browser Link Chrome extension,
 * filters it through the PrivacyGuard, and stores it in the recall system
 * (VectorMemory) so the ActivityWatcher, KnowledgeGraph, and agent loop
 * can reason about browser-level activity.
 */
export class ChromeExtensionBridge {
  private recall: VectorMemory;
  private knowledge: KnowledgeGraph;
  private privacy: PrivacyGuard;
  private credentialVault?: CredentialVault;
  private consentGate?: ConsentGate;
  private config: ChromeExtensionBridgeConfig;
  private sessionId: string = '';
  private eventCount: number = 0;
  private lastFlushAt: number = Date.now();
  private cookieDomains: Set<string> = new Set();
  private loginEvents: Array<{ url: string; provider: string; ts: number; username?: string }> = [];
  private pendingLogins: Array<{ url: string; provider: string; ts: number; username?: string }> = [];
  private activeSessions: Map<string, { startedAt: number; eventCount: number; cookieDomains: number }> = new Map();

  constructor(
    recall: VectorMemory,
    knowledge: KnowledgeGraph,
    privacy: PrivacyGuard,
    config: ChromeExtensionBridgeConfig,
    credentialVault?: CredentialVault,
    consentGate?: ConsentGate,
  ) {
    this.recall = recall;
    this.knowledge = knowledge;
    this.privacy = privacy;
    this.credentialVault = credentialVault;
    this.consentGate = consentGate;
    this.config = config;
    // Load persisted logins from DB
    try {
      const rows = this.recall.getChromeLogins(100);
      this.loginEvents = rows.map((r: any) => ({ url: r.url, provider: r.provider || 'unknown', ts: new Date(r.created_at).getTime() }));
    } catch {}
  }

  setVault(vault: CredentialVault): void { this.credentialVault = vault; }
  setConsent(gate: ConsentGate): void { this.consentGate = gate; }

  /**
   * Process a batch of telemetry events from the Chrome extension.
   */
  async handleTelemetry(events: ChromeTelemetryEvent[], sessionId: string, cookieSnapshot: CookieSnapshot): Promise<{
    processed: number;
    filtered: number;
    sessionId: string;
  }> {
    if (!this.sessionId) this.sessionId = sessionId;

    let filtered = 0;
    for (const event of events) {
      const processed = await this.processEvent(event, sessionId);
      if (!processed) filtered++;
    }

    // Update cookie snapshot
    if (cookieSnapshot) {
      this.cookieDomains = new Set(Object.keys(cookieSnapshot));
    }

    // Persist cookie snapshot to DB
    if (cookieSnapshot) {
      for (const [domain, cookies] of Object.entries(cookieSnapshot)) {
        for (const c of cookies as any[]) {
          try { this.recall.saveChromeCookie(domain, c); } catch {}
        }
      }
    }
    // Persist history/sites from events that carry url/title
    for (const e of events) {
      if ((e.type === 'browser:history' || e.type === 'tabs:state' || e.type === 'nav:complete') && e.url) {
        try { this.recall.saveChromeSite(e.url, e.title, (e as any).visitCount, e.ts); } catch {}
      }
      if (e.type === 'browser:history' && (e as any).entries) {
        for (const h of (e as any).entries as any[]) {
          try { this.recall.saveChromeSite(h.url, h.title, h.visitCount, h.lastVisitTime); } catch {}
        }
      }
    }

    // Track session stats
    const session = this.activeSessions.get(sessionId) || {
      startedAt: Date.now(),
      eventCount: 0,
      cookieDomains: 0,
    };
    session.eventCount += events.length;
    session.cookieDomains = this.cookieDomains.size;
    this.activeSessions.set(sessionId, session);

    this.eventCount += events.length;
    this.lastFlushAt = Date.now();

    // Emit bus event so the UI can show Chrome extension activity
    eventBus.emit('chrome:telemetry', {
      sessionId,
      eventCount: events.length,
      totalEvents: this.eventCount,
    });

    getLogger().debug({
      sessionId,
      events: events.length,
      filtered,
      total: this.eventCount,
    }, 'Chrome extension telemetry received');

    return {
      processed: events.length - filtered,
      filtered,
      sessionId,
    };
  }

  private async processEvent(event: ChromeTelemetryEvent, sessionId: string): Promise<boolean> {
    const isLoginLike = event.type.startsWith('login') || event.type.startsWith('oauth') || event.type === 'form:submit' || event.type === 'webrequest:post';
    const privacyCheck = this.privacy.inspectUrl(event.url || '', { allowLogin: isLoginLike });
    if (!privacyCheck.allowed) return false;

    const ts = event.ts || Date.now();

    switch (event.type) {
      case 'session:start':
        this.sessionId = sessionId;
        getLogger().info({ sessionId }, 'Chrome extension session started');
        return true;

      case 'cookies:sweep':
        this.recall.logUserActivity({
          appName: 'chrome-extension',
          windowTitle: '',
          action: 'cookie_sweep',
          contextTags: `cookies,domain_count:${event.domainCount},cookie_count:${event.cookieCount}`,
          durationSec: 0,
          keystrokeCount: 0,
          clickCount: 0,
          scrollCount: 0,
          isActive: true,
          sessionId,
          hourOfDay: new Date(ts).getHours(),
          dayOfWeek: new Date(ts).getDay(),
        });
        return true;

      case 'tab:created':
      case 'tab:removed':
      case 'tab:activate':
        this.recall.logUserActivity({
          appName: 'chrome-extension',
          windowTitle: '',
          action: event.type,
          targetUrl: event.url,
          contextTags: 'browser,tab',
          durationSec: 0,
          keystrokeCount: 0,
          clickCount: 0,
          scrollCount: 0,
          isActive: true,
          sessionId,
          hourOfDay: new Date(ts).getHours(),
          dayOfWeek: new Date(ts).getDay(),
        });
        return true;

      case 'tab:navigate':
        this.recall.logUserActivity({
          appName: 'chrome-extension',
          windowTitle: event.title || '',
          action: 'navigate',
          targetUrl: event.url,
          contextTags: 'browser,navigation',
          durationSec: 0,
          keystrokeCount: 0,
          clickCount: 0,
          scrollCount: 0,
          isActive: true,
          sessionId,
          hourOfDay: new Date(ts).getHours(),
          dayOfWeek: new Date(ts).getDay(),
        });
        return true;

      case 'oauth:detected':
        this.loginEvents.push({ url: event.url || '', provider: event.provider || 'unknown', ts });
        this.recall.logUserActivity({
          appName: 'chrome-extension',
          windowTitle: '',
          action: 'oauth_flow',
          targetUrl: event.url,
          contextTags: `browser,oauth,provider:${event.provider}`,
          durationSec: 0,
          keystrokeCount: 0,
          clickCount: 0,
          scrollCount: 0,
          isActive: true,
          sessionId,
          hourOfDay: new Date(ts).getHours(),
          dayOfWeek: new Date(ts).getDay(),
        });

        // Also record as a knowledge node for the agent to reason about
        await this.knowledge.addOrUpdate(
          `browser/oauth/${event.provider}-${ts}`,
          `OAuth Login: ${event.provider}`,
          `User initiated an OAuth flow with ${event.provider}.\nURL: ${event.url}\nPrevious: ${event.prevUrl}\nTime: ${new Date(ts).toISOString()}`,
          ['browser', 'oauth', event.provider || 'unknown', 'login'],
          ['browser-activity'],
          'system',
        ).catch(() => {});
        return true;

      case 'login:detected':
      case 'login:submitted': {
        const username = (event as any).username || '';
        this.loginEvents.push({ url: event.url || '', provider: event.provider || 'unknown', ts, username });
        this.pendingLogins.push({ url: event.url || '', provider: event.provider || 'unknown', ts, username });
        // Persist to DB
        try { this.recall.saveChromeLogin(event.url || '', event.provider || 'unknown', !!event.hasPassword, sessionId); } catch {}
        this.recall.logUserActivity({
          appName: 'chrome-extension',
          windowTitle: '',
          action: event.type === 'login:submitted' ? 'login_submit' : 'login_detected',
          targetUrl: event.url,
          contextTags: `browser,login,provider:${event.provider || 'unknown'},has_password:${event.hasPassword},username:${username ? 'yes' : 'no'}`,
          durationSec: 0,
          keystrokeCount: 0,
          clickCount: 0,
          scrollCount: 0,
          isActive: true,
          sessionId,
          hourOfDay: new Date(ts).getHours(),
          dayOfWeek: new Date(ts).getDay(),
        });
        // Auto-register with consent: ask to save login
        if (event.type === 'login:submitted' && this.consentGate && this.credentialVault) {
          const provider = event.provider || new URL(event.url || 'https://unknown').hostname;
          void this.consentGate.request(`Save login for ${provider} (${event.url})?`).then(res => {
            if (res === 'granted' && this.credentialVault?.isUnlocked) {
              try {
                const svc = `login:${provider}`;
                // Don't store password — only mark that login exists, username if captured, user can add secret later
                if (username) {
                  this.credentialVault!.set({ service: svc, username, secret: '' });
                } else {
                  this.credentialVault!.set({ service: svc, username: 'user', secret: '' });
                }
                getLogger().info({ provider, url: event.url }, 'Login auto-registered to vault');
                (eventBus as any).emit('chrome:login-saved', { provider, url: event.url });
              } catch {}
            }
          });
        }
        return true;
      }

      case 'form:submit':
        this.recall.logUserActivity({
          appName: 'chrome-extension',
          windowTitle: '',
          action: event.isLoginLike ? 'login_form_submit' : 'form_submit',
          targetUrl: event.url,
          contextTags: `browser,form${event.isLoginLike ? ',login' : ''}`,
          durationSec: 0,
          keystrokeCount: 0,
          clickCount: 0,
          scrollCount: 0,
          isActive: true,
          sessionId,
          hourOfDay: new Date(ts).getHours(),
          dayOfWeek: new Date(ts).getDay(),
        });
        return true;

      case 'nav:complete':
        this.recall.logUserActivity({
          appName: 'chrome-extension',
          windowTitle: '',
          action: 'page_load',
          targetUrl: event.url,
          contextTags: 'browser,navigation',
          durationSec: 0,
          keystrokeCount: 0,
          clickCount: 0,
          scrollCount: 0,
          isActive: true,
          sessionId,
          hourOfDay: new Date(ts).getHours(),
          dayOfWeek: new Date(ts).getDay(),
        });
        return true;

      case 'activity:heartbeat':
        this.recall.logUserActivity({
          appName: 'chrome-extension',
          windowTitle: event.title || '',
          action: 'heartbeat',
          targetUrl: event.url,
          contextTags: `browser,heartbeat,links:${event.linkCount || 0},forms:${event.formCount || 0}`,
          durationSec: 30,
          keystrokeCount: 0,
          clickCount: 0,
          scrollCount: 0,
          isActive: true,
          sessionId,
          hourOfDay: new Date(ts).getHours(),
          dayOfWeek: new Date(ts).getDay(),
        });
        return true;

      case 'tab:title':
        // Lightweight — don't log every title change
        return true;

      case 'browser:stats':
        this.recall.logUserActivity({
          appName: 'chrome-extension',
          windowTitle: '',
          action: 'browser_stats',
          contextTags: `browser,stats,bookmarks:${(event as any).bookmarkCount||0},history:${(event as any).historyCount||0},tabs:${(event as any).tabCount||0}`,
          durationSec: 0, keystrokeCount: 0, clickCount: 0, scrollCount: 0, isActive: true, sessionId,
          hourOfDay: new Date(ts).getHours(), dayOfWeek: new Date(ts).getDay(),
        });
        return true;

      case 'browser:extensions':
        this.recall.logUserActivity({
          appName: 'chrome-extension',
          windowTitle: '',
          action: 'browser_extensions',
          contextTags: `browser,extensions,count:${(event as any).count||0}`,
          durationSec: 0, keystrokeCount: 0, clickCount: 0, scrollCount: 0, isActive: true, sessionId,
          hourOfDay: new Date(ts).getHours(), dayOfWeek: new Date(ts).getDay(),
        });
        return true;

      case 'browser:history':
        if ((event as any).entries) {
          for (const h of (event as any).entries as any[]) {
            try { this.recall.saveChromeSite(h.url, h.title, h.visitCount, h.lastVisitTime); } catch {}
          }
        }
        this.recall.logUserActivity({
          appName: 'chrome-extension',
          windowTitle: '',
          action: 'browser_history',
          contextTags: `browser,history,count:${(event as any).count||0}`,
          durationSec: 0, keystrokeCount: 0, clickCount: 0, scrollCount: 0, isActive: true, sessionId,
          hourOfDay: new Date(ts).getHours(), dayOfWeek: new Date(ts).getDay(),
        });
        return true;

      case 'connector:session':
        // Handle connector session from Chrome extension
        void this.handleConnectorSession({
          provider: (event as any).provider || 'unknown',
          url: event.url || '',
          cookies: (event as any).cookies || [],
          timestamp: ts,
        }).catch(err => {
          getLogger().error({ err }, 'Failed to handle connector session');
        });
        return true;

      case 'tabs:state':
      case 'cookies:auth':
      case 'tab:audible':
      case 'tab:pinned':
      case 'tab:detach':
      case 'tab:attach':
      case 'window:created':
      case 'window:removed':
      case 'nav:commit':
      case 'webrequest:post':
      case 'webrequest:redirect':
      case 'page:visibility':
      case 'page:performance':
        this.recall.logUserActivity({
          appName: 'chrome-extension',
          windowTitle: event.title || '',
          action: event.type.replace(':', '_'),
          targetUrl: event.url,
          contextTags: `browser,${event.type}`,
          durationSec: 0, keystrokeCount: 0, clickCount: 0, scrollCount: 0, isActive: true, sessionId,
          hourOfDay: new Date(ts).getHours(), dayOfWeek: new Date(ts).getDay(),
        });
        return true;

      default:
        getLogger().debug({ type: event.type }, 'Unknown Chrome extension event type');
        return false;
    }
  }

  /**
   * Get status for the API endpoint.
   */
  getStatus(): {
    active: boolean;
    eventCount: number;
    sessionCount: number;
    loginEvents: number;
    cookieDomains: number;
    sessions: Record<string, { startedAt: number; eventCount: number; cookieDomains: number }>;
  } {
    return {
      active: this.eventCount > 0 && (Date.now() - this.lastFlushAt) < 60_000,
      eventCount: this.eventCount,
      sessionCount: this.activeSessions.size,
      loginEvents: this.loginEvents.length,
      cookieDomains: this.cookieDomains.size,
      sessions: Object.fromEntries(this.activeSessions),
    };
  }

  /**
   * Get login events (provider, timestamp).
   */
  getLoginEvents(): Array<{ url: string; provider: string; ts: number; username?: string }> {
    return [...this.loginEvents];
  }

  getPendingLogins(): Array<{ url: string; provider: string; ts: number; username?: string }> {
    return [...this.pendingLogins];
  }

  async approveLogin(url: string, provider: string, username?: string): Promise<boolean> {
    if (!this.credentialVault?.isUnlocked) throw new Error('Vault locked');
    const svc = `login:${provider || new URL(url).hostname}`;
    this.credentialVault.set({ service: svc, username: username || 'user', secret: '' });
    this.pendingLogins = this.pendingLogins.filter(l => l.url !== url || l.provider !== provider);
    getLogger().info({ provider, url }, 'Login approved and saved to vault');
    return true;
  }

  getChromeCookies(domain?: string): any[] {
    return this.recall.getChromeCookies(domain);
  }

  getChromeSites(limit: number = 200): any[] {
    return this.recall.getChromeSites(limit);
  }

  /**
   * Handle a connector session from the Chrome extension.
   * Maps the login to an MCP connector and stores the session.
   */
  async handleConnectorSession(session: ConnectorSession): Promise<{
    connected: boolean;
    connectorId: string;
    provider: string;
  }> {
    const { provider, url, cookies, timestamp } = session;
    
    // Map provider to MCP connector capabilities
    const connector = this.mapProviderToConnector(provider, url);
    
    if (!connector) {
      getLogger().warn({ provider }, 'No connector mapping found for provider');
      return { connected: false, connectorId: '', provider };
    }

    // Store the session in the credential vault
    if (this.credentialVault?.isUnlocked) {
      const service = `connector:${connector.id}`;
      
      // Store cookies as the "secret" (encrypted)
      const sessionData = {
        cookies,
        url,
        timestamp,
        lastRefresh: timestamp,
      };
      
      this.credentialVault.set({
        service,
        username: provider,
        secret: JSON.stringify(sessionData),
      });

      getLogger().info({ provider, connectorId: connector.id }, 'Connector session saved to vault');
    }

    // Add knowledge node about the connection
    await this.knowledge.addOrUpdate(
      `connector/${provider}-${timestamp}`,
      `Connected: ${connector.name}`,
      `User connected ${connector.name} via browser login.\nURL: ${url}\nTime: ${new Date(timestamp).toISOString()}\nCapabilities: ${connector.capabilities.join(', ')}`,
      ['connector', provider, 'connected'],
      ['browser-activity', 'connectors'],
      'system',
    ).catch(() => {});

    // Emit event for the API to register the connector
    eventBus.emit('chrome:connector-saved', {
      provider,
      connectorId: connector.id,
      connectorName: connector.name,
      capabilities: connector.capabilities,
      sessionStored: true,
    });

    return {
      connected: true,
      connectorId: connector.id,
      provider,
    };
  }

  /**
   * Map a provider to its MCP connector configuration.
   */
  private mapProviderToConnector(provider: string, url: string): {
    id: string;
    name: string;
    category: string;
    capabilities: string[];
    baseUrl?: string;
    authType: string;
  } | null {
    const providers: Record<string, {
      id: string;
      name: string;
      category: string;
      capabilities: string[];
      baseUrl?: string;
      authType: string;
    }> = {
      'google': {
        id: 'google-workspace',
        name: 'Google Workspace',
        category: 'Productivity',
        capabilities: ['gmail', 'drive', 'calendar', 'docs', 'sheets'],
        baseUrl: 'https://www.googleapis.com',
        authType: 'oauth',
      },
      'gmail': {
        id: 'gmail',
        name: 'Gmail',
        category: 'Communication',
        capabilities: ['send_email', 'read_email', 'search_email', 'manage_labels'],
        baseUrl: 'https://www.googleapis.com/gmail/v1',
        authType: 'oauth',
      },
      'microsoft': {
        id: 'microsoft-365',
        name: 'Microsoft 365',
        category: 'Productivity',
        capabilities: ['outlook', 'onedrive', 'teams', 'office'],
        baseUrl: 'https://graph.microsoft.com',
        authType: 'oauth',
      },
      'github': {
        id: 'github',
        name: 'GitHub',
        category: 'Developer',
        capabilities: ['repos', 'issues', 'pull_requests', 'code_search'],
        baseUrl: 'https://api.github.com',
        authType: 'bearer',
      },
      'slack': {
        id: 'slack',
        name: 'Slack',
        category: 'Communication',
        capabilities: ['channels', 'messages', 'files', 'users'],
        baseUrl: 'https://slack.com/api',
        authType: 'bearer',
      },
      'discord': {
        id: 'discord',
        name: 'Discord',
        category: 'Communication',
        capabilities: ['servers', 'channels', 'messages', 'users'],
        baseUrl: 'https://discord.com/api',
        authType: 'bearer',
      },
      'twitter': {
        id: 'twitter',
        name: 'Twitter/X',
        category: 'Social',
        capabilities: ['tweets', 'timeline', 'mentions', 'dm'],
        baseUrl: 'https://api.twitter.com/2',
        authType: 'bearer',
      },
      'linkedin': {
        id: 'linkedin',
        name: 'LinkedIn',
        category: 'Professional',
        capabilities: ['profile', 'posts', 'messages', 'connections'],
        baseUrl: 'https://api.linkedin.com/v2',
        authType: 'bearer',
      },
      'facebook': {
        id: 'facebook',
        name: 'Facebook',
        category: 'Social',
        capabilities: ['feed', 'pages', 'messenger', 'ads'],
        baseUrl: 'https://graph.facebook.com',
        authType: 'bearer',
      },
      'amazon': {
        id: 'amazon',
        name: 'Amazon',
        category: 'E-commerce',
        capabilities: ['orders', 'wishlist', 'products', 'prime'],
        baseUrl: 'https://api.amazon.com',
        authType: 'bearer',
      },
      'spotify': {
        id: 'spotify',
        name: 'Spotify',
        category: 'Entertainment',
        capabilities: ['playlists', 'library', 'search', 'playback'],
        baseUrl: 'https://api.spotify.com/v1',
        authType: 'bearer',
      },
      'netflix': {
        id: 'netflix',
        name: 'Netflix',
        category: 'Entertainment',
        capabilities: ['browse', 'search', 'my_list', 'recently_watched'],
        baseUrl: 'https://www.netflix.com',
        authType: 'bearer',
      },
      'dropbox': {
        id: 'dropbox',
        name: 'Dropbox',
        category: 'Productivity',
        capabilities: ['files', 'folders', 'sharing', 'search'],
        baseUrl: 'https://api.dropboxapi.com/2',
        authType: 'bearer',
      },
      'zoom': {
        id: 'zoom',
        name: 'Zoom',
        category: 'Communication',
        capabilities: ['meetings', 'recordings', 'contacts', 'webinars'],
        baseUrl: 'https://api.zoom.us/v2',
        authType: 'bearer',
      },
    };

    // Check for exact provider match first
    if (providers[provider]) {
      return providers[provider];
    }

    // Check URL for provider hints
    const urlLower = url.toLowerCase();
    for (const [key, config] of Object.entries(providers)) {
      if (urlLower.includes(key)) {
        return config;
      }
    }

    // Check for common services
    if (/google|gmail|drive|calendar/i.test(urlLower)) {
      return providers['google'];
    }
    if (/microsoft|outlook|onedrive|office/i.test(urlLower)) {
      return providers['microsoft'];
    }
    if (/github/i.test(urlLower)) {
      return providers['github'];
    }

    return null;
  }

  /**
   * Get all connected connectors.
   */
  getConnectedConnectors(): Array<{
    id: string;
    name: string;
    provider: string;
    connectedAt: number;
    lastUsed?: number;
  }> {
    if (!this.credentialVault?.isUnlocked) {
      return [];
    }

    const connectors: Array<{
      id: string;
      name: string;
      provider: string;
      connectedAt: number;
      lastUsed?: number;
    }> = [];

    // List all connector services in the vault
    const entries = this.credentialVault.list();
    for (const entry of entries) {
      if (entry.service.startsWith('connector:')) {
        const connectorId = entry.service.replace('connector:', '');
        try {
          const sessionData = JSON.parse(entry.secret);
          connectors.push({
            id: connectorId,
            name: entry.username || connectorId,
            provider: entry.username || connectorId,
            connectedAt: sessionData.timestamp,
            lastUsed: sessionData.lastRefresh,
          });
        } catch {}
      }
    }

    return connectors;
  }

  /**
   * Disconnect a connector (remove from vault).
   */
  async disconnectConnector(connectorId: string): Promise<boolean> {
    if (!this.credentialVault?.isUnlocked) {
      return false;
    }

    const service = `connector:${connectorId}`;
    const removed = this.credentialVault.remove(service);
    
    if (removed) {
      getLogger().info({ connectorId }, 'Connector disconnected');
      
      // Add knowledge node about disconnection
      await this.knowledge.addOrUpdate(
        `connector/${connectorId}/disconnected`,
        `Disconnected: ${connectorId}`,
        `User disconnected connector ${connectorId}.\nTime: ${new Date().toISOString()}`,
        ['connector', connectorId, 'disconnected'],
        ['browser-activity', 'connectors'],
        'system',
      ).catch(() => {});

      eventBus.emit('chrome:connector-disconnected', { connectorId });
    }

    return removed;
  }
}
