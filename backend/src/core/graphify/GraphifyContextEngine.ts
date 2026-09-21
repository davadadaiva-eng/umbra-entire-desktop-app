/**
 * GraphifyContextEngine — the end-to-end compression pipeline:
 *
 *   raw context ──▶ Chunker ──▶ Clustering ──▶ Summarizer ──▶ compressed prompt
 *                                  │
 *                                  └──▶ Clique map for on-demand expansion
 *
 * "10,000 tokens → ~300-token vector summary + expandable graph."
 */

import { Caveman, CavemanOptions, estimateTokens } from './Caveman';
import { Chunker, Chunk } from './Chunker';
import { Clustering, Clique } from './Clustering';
import { GraphSummarizer, SummarizeFn } from './GraphSummarizer';

export interface CompressedContext {
  prompt: string;
  originalTokens: number;
  promptTokens: number;
  savings: number;
  cliques: Clique[];
  summaries: Map<number, string>;
  chunks: Chunk[];
}

export interface GraphifyOptions {
  caveman?: CavemanOptions;
  targetChunkTokens?: number;
  threshold?: number;
  targetTokens?: number;
  summarize?: SummarizeFn;
  embeddings?: (chunk: string) => Promise<number[]> | number[];
}

export class GraphifyContextEngine {
  private caveman: Caveman;
  private chunker: Chunker;
  private clustering: Clustering;
  private summarizer: GraphSummarizer;
  private embeddings?: (chunk: string) => Promise<number[]> | number[];

  constructor(options: GraphifyOptions = {}) {
    this.caveman = new Caveman(options.caveman || {});
    this.chunker = new Chunker({ chunkTokens: options.targetChunkTokens ?? 400 });
    this.clustering = new Clustering({ threshold: options.threshold ?? 0.55 });
    this.summarizer = new GraphSummarizer({
      summarize: options.summarize,
      targetTokens: options.targetTokens ?? 300,
    });
    this.embeddings = options.embeddings;
  }

  async compress(context: string, source = 'context'): Promise<CompressedContext> {
    const originalTokens = estimateTokens(context);
    const chunks = this.chunker.chunk(context, source);

    const embeddings: (number[] | null)[] = Array.from({ length: chunks.length }, () => null);
    if (this.embeddings) {
      await Promise.all(
        chunks.map(async (chunk, i) => {
          try {
            const vec = await this.embeddings!(chunk.text);
            if (Array.isArray(vec) && vec.length > 0) embeddings[i] = vec;
          } catch {
            embeddings[i] = null;
          }
        }),
      );
    }

    const cliques = this.clustering.cluster(chunks.map(c => c.text), embeddings);
    const summaries = await this.summarizer.summarizeCliques(cliques);

    // Build the compressed prompt: cave-man header + clique digests.
    const lines: string[] = [];
    for (const clique of cliques) {
      const digest = summaries.get(clique.id) || '';
      if (!digest) continue;
      lines.push(
        `[C${clique.id} ~${clique.memberIds.length} nodes, cohesion ${clique.cohesion.toFixed(2)}] ${digest}`,
      );
    }
    let prompt = lines.join('\n');
    prompt = this.caveman.compress(prompt);

    const promptTokens = estimateTokens(prompt);
    return {
      prompt,
      originalTokens,
      promptTokens,
      savings: originalTokens === 0 ? 0 : 1 - promptTokens / originalTokens,
      cliques,
      summaries,
      chunks,
    };
  }

  /** Expand a single clique back to near-verbatim context (reasoning-engine probe). */
  async expandClique(result: CompressedContext, cliqueId: number): Promise<string> {
    const clique = result.cliques.find(c => c.id === cliqueId);
    if (!clique) return '';
    return clique.members.join('\n---\n');
  }
}
