import { getLogger } from '../Logger';

export interface PrivacyRule {
  type: 'app' | 'url' | 'window_title' | 'file_path' | 'keyword';
  pattern: string;
  action: 'block_watch' | 'block_keystrokes' | 'block_capture' | 'block_all';
  reason: string;
}

export interface PrivacyAuditEntry {
  timestamp: Date;
  action: 'blocked' | 'masked' | 'allowed';
  ruleType: string;
  matchedPattern: string;
  appName: string;
}

export class PrivacyGuard {
  private rules: PrivacyRule[] = [];
  private auditLog: PrivacyAuditEntry[] = [];
  private enabled: boolean = true;
  private maxAuditEntries: number = 1000;

  private static readonly DEFAULT_BLOCKED_APPS: string[] = [
    'keepass', 'keepassxc', 'bitwarden', '1password', 'lastpass', 'dashlane',
    'protonpass', 'nordpass', 'roboform', 'keeper', 'enpass', 'password',
    'bank', 'banking', 'paypal', 'venmo', 'cashapp', 'wise', 'revolut',
    'chase', 'wells fargo', 'bank of america', 'citi', 'capital one',
    'us bank', 'pnc', 'td bank', 'hsbc', 'barclays', 'santander',
    'schwab', 'fidelity', 'vanguard', 'etrade', 'robinhood', 'webull',
    'saxo', 'interactive brokers', 'coinbase', 'binance', 'kraken',
    'gemini', 'crypto.com', 'metamask', 'ledger live', 'trezor',
    'intuit', 'quickbooks', 'turbotax', 'hr block', 'tax',
    'healthcare.gov', 'medicare', 'aetna', 'cigna', 'unitedhealthcare',
    'gsuite', 'google admin', 'okta', 'duo', 'authenticator',
    'adobe sign', 'docusign', 'hellosign',
    'signal', 'telegram desktop',
  ];

  private static readonly DEFAULT_BLOCKED_URLS: string[] = [
    'bank', 'banking', 'onlinebanking', 'paypal.com', 'venmo.com',
    'chase.com', 'wellsfargo.com', 'bankofamerica.com', 'capitalone.com',
    'citi.com', 'usbank.com', 'pnc.com', 'tdbank.com',
    'schwab.com', 'fidelity.com', 'vanguard.com', 'etrade.com',
    'robinhood.com', 'coinbase.com', 'binance.com', 'kraken.com',
    'login', 'signin', 'auth', 'authenticator',
    'password', 'credential', 'secret', '2fa', 'mfa',
    'tax', 'irs.gov', 'turbotax',
    'healthcare', 'patient', 'medical',
    'docusign', 'adobesign', 'esign',
    'okta.com', 'duosecurity',
    'admin', 'dashboard',
  ];

  private static readonly DEFAULT_BLOCKED_TITLES: string[] = [
    'password', 'credential', 'secret key', '2fa', 'mfa',
    'authenticator', 'verification code', 'otp', 'one-time',
    'security', 'pin code', 'login', 'sign in',
    'recovery', 'backup code',
    'payment', 'billing', 'invoice',
    'tax', 'w2', 'ssn', 'social security',
    'medical', 'hipaa', 'diagnosis', 'prescription',
  ];

  private static readonly SENSITIVE_KEYWORDS: RegExp[] = [
    /\b\d{4}[- ]?\d{4}[- ]?\d{4}[- ]?\d{4}\b/,       // credit card
    /\b\d{3}[- ]?\d{2}[- ]?\d{4}\b/,                   // SSN
    /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/, // email
    /\b(?:password|passwd|pwd|secret)\s*[:=]\s*\S+/i,  // password assignment
    /\b(?:api[_-]?key|apikey|api_key)\s*[:=]\s*\S+/i, // API key
    /\b(?:eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b/, // JWT
    /\b(?:sk-[A-Za-z0-9]{20,})\b/,                     // OpenAI key
    /\b(?:-----BEGIN (?:RSA |EC )?PRIVATE KEY-----)/,   // PEM private key
  ];

  constructor() {
    this.loadDefaults();
  }

  private loadDefaults(): void {
    for (const app of PrivacyGuard.DEFAULT_BLOCKED_APPS) {
      this.rules.push({
        type: 'app',
        pattern: app.toLowerCase(),
        action: 'block_all',
        reason: `Sensitive application: ${app}`,
      });
    }

    for (const url of PrivacyGuard.DEFAULT_BLOCKED_URLS) {
      this.rules.push({
        type: 'url',
        pattern: url.toLowerCase(),
        action: 'block_all',
        reason: `Sensitive URL pattern: ${url}`,
      });
    }

    for (const title of PrivacyGuard.DEFAULT_BLOCKED_TITLES) {
      this.rules.push({
        type: 'window_title',
        pattern: title.toLowerCase(),
        action: 'block_keystrokes',
        reason: `Sensitive window title pattern: ${title}`,
      });
    }
  }

  // ─── Public API ────────────────────────────────────────────

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    getLogger().info({ enabled }, 'Privacy guard');
  }

  addRule(rule: PrivacyRule): void {
    this.rules.push(rule);
    getLogger().info({ type: rule.type, pattern: rule.pattern, action: rule.action }, 'Privacy rule added');
  }

  removeRule(type: PrivacyRule['type'], pattern: string): boolean {
    const index = this.rules.findIndex(r => r.type === type && r.pattern === pattern);
    if (index !== -1) {
      this.rules.splice(index, 1);
      return true;
    }
    return false;
  }

  addBlockedApp(appName: string): void {
    this.addRule({ type: 'app', pattern: appName.toLowerCase(), action: 'block_all', reason: `User blocked: ${appName}` });
  }

  addBlockedUrl(urlPattern: string): void {
    this.addRule({ type: 'url', pattern: urlPattern.toLowerCase(), action: 'block_all', reason: `User blocked URL: ${urlPattern}` });
  }

  getRules(): PrivacyRule[] {
    return [...this.rules];
  }

  // ─── Inspection ────────────────────────────────────────────

  inspectApp(appName: string): { allowed: boolean; blockKeystrokes: boolean; blockCapture: boolean; reason?: string } {
    if (!this.enabled) return { allowed: true, blockKeystrokes: false, blockCapture: false };

    const lowApp = appName.toLowerCase();
    for (const rule of this.rules) {
      if (rule.type === 'app' && lowApp.includes(rule.pattern)) {
        this.audit({ action: 'blocked', ruleType: 'app', matchedPattern: rule.pattern, appName });
        const action = rule.action;
        if (action === 'block_all') return { allowed: false, blockKeystrokes: true, blockCapture: true, reason: rule.reason };
        return { allowed: true, blockKeystrokes: action === 'block_keystrokes', blockCapture: action === 'block_capture', reason: rule.reason };
      }
    }
    return { allowed: true, blockKeystrokes: false, blockCapture: false };
  }

  inspectUrl(url: string, opts?: { allowLogin?: boolean }): { allowed: boolean; reason?: string } {
    if (!this.enabled || !url) return { allowed: true };
    // Exemption: chrome extension login/oauth events must not be blocked by generic login/auth url rules
    if (opts?.allowLogin) {
      const low = url.toLowerCase();
      if (/(login|signin|auth|oauth|sso|session|callback|token|consent)/i.test(low)) return { allowed: true };
    }

    const lowUrl = url.toLowerCase();
    for (const rule of this.rules) {
      if (rule.type === 'url' && lowUrl.includes(rule.pattern)) {
        this.audit({ action: 'blocked', ruleType: 'url', matchedPattern: rule.pattern, appName: url });
        return { allowed: false, reason: rule.reason };
      }
    }
    return { allowed: true };
  }

  inspectWindowTitle(title: string): { blockKeystrokes: boolean; reason?: string } {
    if (!this.enabled || !title) return { blockKeystrokes: false };

    const lowTitle = title.toLowerCase();
    for (const rule of this.rules) {
      if (rule.type === 'window_title' && lowTitle.includes(rule.pattern)) {
        this.audit({ action: 'masked', ruleType: 'window_title', matchedPattern: rule.pattern, appName: title });
        return { blockKeystrokes: true, reason: rule.reason };
      }
    }
    return { blockKeystrokes: false };
  }

  inspectFilePath(filePath: string): { allowed: boolean } {
    if (!this.enabled || !filePath) return { allowed: true };

    const lowPath = filePath.toLowerCase();
    for (const rule of this.rules) {
      if (rule.type === 'file_path' && lowPath.includes(rule.pattern)) {
        this.audit({ action: 'blocked', ruleType: 'file_path', matchedPattern: rule.pattern, appName: filePath });
        return { allowed: false };
      }
    }
    return { allowed: true };
  }

  // ─── Sensitive Data Filtering ──────────────────────────────

  filterSensitiveData(text: string): string {
    if (!this.enabled || !text) return text;

    let filtered = text;
    for (const regex of PrivacyGuard.SENSITIVE_KEYWORDS) {
      filtered = filtered.replace(regex, (match) => {
        if (regex.source.includes('@')) return '***@***.***';
        if (regex.source.includes('BEGIN')) return '-----BEGIN PRIVATE KEY-----***';
        if (regex.source.includes('sk-')) return 'sk-***';
        if (regex.source.includes('eyJ')) return '***.*****.***';
        return match.length > 8 ? match.substring(0, 4) + '****' : match;
      });
    }
    return filtered;
  }

  maskWindowTitle(title: string): string {
    for (const rule of this.rules) {
      if (rule.type === 'window_title' && title.toLowerCase().includes(rule.pattern)) {
        return `[Privacy Masked: ${rule.reason}]`;
      }
    }

    for (const regex of PrivacyGuard.SENSITIVE_KEYWORDS) {
      if (regex.test(title)) {
        return '[Privacy Masked: Sensitive Content]';
      }
    }

    return title;
  }

  // ─── Audit ─────────────────────────────────────────────────

  getAuditLog(): PrivacyAuditEntry[] {
    return [...this.auditLog];
  }

  getStats(): { rulesCount: number; blocksToday: number; masksToday: number } {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayEntries = this.auditLog.filter(e => e.timestamp >= today);
    return {
      rulesCount: this.rules.length,
      blocksToday: todayEntries.filter(e => e.action === 'blocked').length,
      masksToday: todayEntries.filter(e => e.action === 'masked').length,
    };
  }

  private audit(entry: Omit<PrivacyAuditEntry, 'timestamp'>): void {
    const fullEntry: PrivacyAuditEntry = { ...entry, timestamp: new Date() };
    this.auditLog.push(fullEntry);
    if (this.auditLog.length > this.maxAuditEntries) {
      this.auditLog.shift();
    }
    getLogger().debug({ action: entry.action, ruleType: entry.ruleType }, 'Privacy guard triggered');
  }
}
