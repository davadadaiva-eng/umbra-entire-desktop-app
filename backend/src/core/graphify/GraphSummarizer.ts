/**
 * GraphSummarizer — condenses each clique down to a ~300-token digest so
 * the agent gets the shape of history without the full token bill.
 *
 * Falls back to a local extraction summarizer when no LLM is configured,
 * keeping the pipeline deterministic in tests.
 */

import { getLogger } from '../Logger';
import { Clique } from './Clustering';
import { estimateTokens } from './Caveman';

export interface SummarizeFn {
  (text: string, maxTokens?: number): Promise<string>;
}

export interface GraphSummarizerOptions {
  summarize?: SummarizeFn;
  targetTokens?: number;
}

export class GraphSummarizer {
  private summarizeFn?: SummarizeFn;
  private targetTokens: number;

  constructor(options: GraphSummarizerOptions = {}) {
    this.summarizeFn = options.summarize;
    this.targetTokens = options.targetTokens ?? 300;
  }

  async summarizeCliques(cliques: Clique[]): Promise<Map<number, string>> {
    const result = new Map<number, string>();
    for (const clique of cliques) {
      const raw = clique.members.join('\n---\n');
      try {
        if (this.summarizeFn) {
          result.set(clique.id, await this.summarizeFn(raw, this.targetTokens));
        } else {
          result.set(clique.id, this.extractive(raw));
        }
      } catch (err) {
        getLogger().warn({ err }, 'Clique summarization failed; falling back to extractive');
        result.set(clique.id, this.extractive(raw));
      }
    }
    return result;
  }

  /** Local, deterministic extractive summarizer (sentence scoring). */
  extractive(text: string, maxTokens = this.targetTokens): string {
    const sentences = text
      .split(/(?<=[.!?])\s+|\n/)
      .map(s => s.trim())
      .filter(s => s.length > 0);
    if (sentences.length === 0) return '';

    const freq = new Map<string, number>();
    for (const s of sentences) {
      for (const w of s.toLowerCase().split(/[^a-z0-9]+/)) {
        if (w.length > 3) freq.set(w, (freq.get(w) || 0) + 1);
      }
    }

    const scored = sentences
      .map((s, idx) => {
        let score = 0;
        for (const w of s.toLowerCase().split(/[^a-z0-9]+/)) {
          if (freq.has(w)) score += freq.get(w)!;
        }
        // Prefer leading sentences (titles, first paragraphs).
        score *= 1 + 1 / (idx + 2);
        return { s, score };
      })
      .sort((a, b) => b.score - a.score);

    const out: string[] = [];
    let budget = maxTokens * 4; // chars
    for (const { s } of scored) {
      if (budget - s.length <= 0) break;
      out.push(s);
      budget -= s.length;
    }
    // Restore source order for readability.
    return out
      .sort((a, b) => sentences.indexOf(a) - sentences.indexOf(b))
      .join(' ')
      .trim();
  }

  tokensSaved(original: string, summary: string): number {
    return Math.max(0, estimateTokens(original) - estimateTokens(summary));
  }
}
