/**
 * InjectionGuard — quarantines prompt-injection attempts before untrusted
 * text (page DOM snapshots, OCR output, tool results) reaches an LLM.
 *
 * Targets the OWASP LLM Top 10 / MITRE ATLAS prompt-injection families:
 * direct instruction hijacking ("ignore previous instructions"),
 * system-prompt impersonation, hidden instruction blocks, encoded payloads
 * (base64, hex, unicode escapes) and zero-width-character smuggling.
 * Matched spans are replaced with a placeholder so poisoned observations are
 * excluded from planning; every hit is logged and, when a vault is wired in,
 * appended to the tamper-evident audit log.
 */
import { getLogger } from '../Logger';
import { AuditVault } from '../vault/AuditVault';

export interface InjectionHit {
  rule: string;
  reason: string;
  /** Truncated excerpt of the matched span. */
  snippet: string;
  /** Character offset of the match in the scanned input. */
  index: number;
}

export interface ScanResult {
  clean: boolean;
  hits: InjectionHit[];
}

export interface ScrubResult extends ScanResult {
  /** Input with poisoned spans replaced by the quarantine placeholder. */
  text: string;
}

/** Placeholder substituted for every quarantined span. */
export const QUARANTINE_PLACEHOLDER = '[quarantined: possible prompt injection]';

export interface InjectionGuardOptions {
  /** When set, every hit is appended to the tamper-evident audit log. */
  vault?: AuditVault;
  /** Extra literal patterns treated as hostile (case-insensitive substrings). */
  extraPatterns?: string[];
  /** Max input length scanned (default 1_000_000 chars). */
  maxInputLength?: number;
}

interface InjectionRule {
  id: string;
  reason: string;
  pattern: RegExp;
}

const RULES: InjectionRule[] = [
  {
    id: 'direct-hijack',
    reason: '"ignore previous instructions" style direct instruction hijacking',
    pattern: /\bignore\s+(?:all\s+)?(?:previous|prior|above|earlier)\s+(?:instructions?|prompts?|rules?|context)\b/i,
  },
  {
    id: 'instruction-redirect',
    reason: 'redirect or disregard previously given instructions',
    pattern: /\b(?:disregard|forget|overlook|abandon|(?:do\s*not|don'?t)\s*(?:follow|obey)|pretend)\s+(?:all\s+)?(?:previous|prior|above|earlier|your)\s+(?:instructions?|prompts?|rules?|commands?|orders?)\b/i,
  },
  {
    id: 'system-impersonation',
    reason: 'system-prompt impersonation',
    pattern: /\b(?:system|assistant)\s*(?:prompt|message|instructions?)?\s*[:=]\s*(?:you\s+are|act\s+as|from\s+now\s+on)\b|you\s+are\s+now\s+(?:an?|the)\s+(?:unrestricted|malicious|jailbroken)\b/i,
  },
  {
    id: 'hidden-block',
    reason: 'hidden instruction block via markup tags',
    pattern: /<(?:(?:system|assistant|user|human|instructions?|hidden|comment|ignore)[^>]*)>[\s\S]{0,2000}?<\/(?:system|assistant|user|human|instructions?|hidden|comment|ignore)>/i,
  },
  {
    id: 'secret-extraction',
    reason: 'attempt to extract secrets or sensitive files',
    pattern: /\b(?:reveal|show|give|send|leak|exfiltrate|exfil|upload|print|output)\b[\s\S]{0,120}?\b(?:passwords?|api\s*keys?|secrets?|tokens?|credentials?|private\s*keys?|config\.json|\.env)\b/i,
  },
  {
    id: 'encoded-payload',
    reason: 'encoded payload smuggling instructions (base64 / hex / unicode escape)',
    pattern: /\b(?:base64|hex|decod[ei]|obfuscate)\b[\s\S]{0,200}?\b[A-Za-z0-9+/]{24,}={0,2}\b|\b[A-Za-z0-9+/]{80,}={0,2}\b|(?:\\u00[0-9a-fA-F]{2}|\\x[0-9a-fA-F]{2}){3,}/i,
  },
  {
    id: 'zero-width',
    reason: 'zero-width / bidi control characters hiding text',
    pattern: /[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/,
  },
  {
    id: 'tool-command',
    reason: 'page instructs the agent to run a command or tool',
    pattern: /\b(?:run|execute|invoke|call|open|launch)\s+(?:this|the)\s+(?:command|script|code|python|bash|powershell|terminal|curl|wget|node)\b/i,
  },
  {
    id: 'jailbreak',
    reason: 'jailbreak / developer-mode framing',
    pattern: /\b(?:DAN|jailbreak|developer\s+mode|unrestricted\s+mode|hypothetical\s+scenario)\b/i,
  },
];

export class InjectionGuard {
  private rules: InjectionRule[];
  private vault?: AuditVault;
  private maxInputLength: number;

  constructor(options: InjectionGuardOptions = {}) {
    this.vault = options.vault;
    this.maxInputLength = options.maxInputLength ?? 1_000_000;
    this.rules = [
      ...RULES,
      ...(options.extraPatterns ?? []).map(pattern => ({
        id: 'custom',
        reason: `custom hostile pattern: ${pattern}`,
        pattern: new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'),
      })),
    ];
  }

  /** Check text for injection attempts without modifying or reporting it. */
  scan(text: string): ScanResult {
    const hits: InjectionHit[] = [];
    const input = this.cap(text);
    for (const rule of this.rules) {
      const match = new RegExp(rule.pattern.source, rule.pattern.flags).exec(input);
      if (match) hits.push(this.toHit(rule, match[0], match.index));
    }
    return { clean: hits.length === 0, hits };
  }

  /** Replace poisoned spans with a placeholder, log the incident, and audit it. */
  scrub(text: string, source = 'observation'): ScrubResult {
    let output = this.cap(text);
    const hits: InjectionHit[] = [];
    if (!output) return { clean: true, hits, text: output };

    for (const rule of this.rules) {
      let attempts = 0;
      while (attempts++ < 100) {
        const match = new RegExp(rule.pattern.source, rule.pattern.flags).exec(output);
        if (!match) break;
        const raw = match[0];
        hits.push(this.toHit(rule, raw, match.index));
        output = output.slice(0, match.index) + QUARANTINE_PLACEHOLDER + output.slice(match.index + raw.length);
      }
    }

    if (hits.length > 0) {
      const rules = [...new Set(hits.map(h => h.rule))];
      getLogger().warn({ source, hitCount: hits.length, rules }, 'Prompt-injection attempt quarantined');
      this.vault?.log('injection_guard', source, {
        rules,
        reasons: hits.slice(0, 5).map(h => h.reason),
        snippets: hits.slice(0, 5).map(h => h.snippet),
      }, 'quarantined');
    }

    return { clean: hits.length === 0, hits, text: output };
  }

  private cap(text: string): string {
    return text.length > this.maxInputLength ? text.slice(0, this.maxInputLength) : text;
  }

  private toHit(rule: InjectionRule, raw: string, index: number): InjectionHit {
    return {
      rule: rule.id,
      reason: rule.reason,
      snippet: raw.length > 140 ? `${raw.slice(0, 140)}…` : raw,
      index,
    };
  }
}
