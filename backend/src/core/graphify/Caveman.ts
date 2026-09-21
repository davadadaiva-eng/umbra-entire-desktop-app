/**
 * Caveman Protocol — a lossy-but-effective prompt densifier.
 *
 * Strips filler words and turns prose into telegraphic payloads before an
 * LLM call, cutting token overhead. Used as step 0 of the Graphify+Caveman
 * compression pipeline ("10,000 tokens → ~300-token vector").
 */

export interface CavemanOptions {
  /** Maximum output length in chars (0 = unlimited). */
  maxLength?: number;
  /** Strip words (case-insensitive). Defaults to English filler set. */
  stopWords?: string[];
  /** Collapse whitespace/newlines. */
  compact?: boolean;
}

const DEFAULT_STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'of', 'to', 'for', 'with', 'at', 'by', 'in', 'on', 'from',
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'have', 'has', 'had', 'do', 'does', 'did',
  'that', 'this', 'these', 'those', 'it', 'its', 'you', 'your', 'yours', 'we', 'our', 'they',
  'please', 'kindly', 'just', 'really', 'very', 'quite', 'however', 'therefore', 'also',
  'would', 'could', 'should', 'shall', 'will', 'can', 'may', 'might', 'must', 'about',
]);

export function estimateTokens(text: string): number {
  if (!text) return 0;
  // Fast heuristic: ~4 chars per token for typical English prose.
  return Math.max(1, Math.ceil(text.replace(/\s+/g, ' ').length / 4));
}

export class Caveman {
  private stopWords: Set<string>;
  private maxLength: number;
  private compact: boolean;

  constructor(options: CavemanOptions = {}) {
    this.stopWords = new Set(options.stopWords || [...DEFAULT_STOP_WORDS]);
    this.maxLength = options.maxLength || 0;
    this.compact = options.compact ?? true;
  }

  /** Densify prose into telegraphic form. */
  compress(text: string): string {
    if (!text) return '';
    let out = text
      .split(/\s+/)
      .map(word => {
        const cleaned = word.replace(/[^a-zA-Z'-]/g, '');
        if (this.stopWords.has(cleaned.toLowerCase())) {
          // Keep punctuation-attached stop words' punctuation (e.g. "and," → ",")
          const punct = word.replace(/[a-zA-Z'-]/g, '');
          return punct;
        }
        return word;
      })
      .filter(w => w.length > 0)
      .join(' ');
    if (this.compact) out = out.replace(/\s+([.,;:!?])/g, '$1').replace(/ {2,}/g, ' ');
    if (this.maxLength > 0 && out.length > this.maxLength) {
      out = out.substring(0, this.maxLength) + '…';
    }
    return out.trim();
  }

  /** Percent of original tokens saved (0-1). */
  savingsRatio(original: string, compressed: string): number {
    const a = estimateTokens(original);
    const b = estimateTokens(compressed);
    if (a === 0) return 0;
    return Math.max(0, 1 - b / a);
  }
}
