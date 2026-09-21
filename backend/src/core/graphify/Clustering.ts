/**
 * Caveman Clustering — community detection over chunk embeddings.
 *
 * Inspired by Louvain/Leiden: build a similarity graph from chunk
 * embeddings and group them into "cliques" of related content. The
 * summarizer then condenses each clique instead of dumping raw history.
 */

import { cosineSimilarity } from '../memory/VectorMemory';

export interface Clique {
  id: number;
  memberIds: string[];
  members: string[];
  /** Mean pairwise similarity of the clique. */
  cohesion: number;
}

export interface ClusteringOptions {
  /** Cosine threshold for an edge between two chunks. */
  threshold?: number;
  /** Minimum clique size. */
  minSize?: number;
}

export class Clustering {
  private threshold: number;
  private minSize: number;

  constructor(options: ClusteringOptions = {}) {
    this.threshold = options.threshold ?? 0.55;
    this.minSize = options.minSize ?? 1;
  }

  /**
   * Cluster chunks by their embeddings.
   * @param chunks chunk texts (index-aligned with embeddings)
   * @param embeddings numeric vectors, or null to fall back to keyword overlap
   */
  cluster(chunks: string[], embeddings: (number[] | null)[]): Clique[] {
    const n = chunks.length;
    if (n === 0) return [];

    // Adjacency via greedy k-NN on similarity.
    const adj: number[][] = Array.from({ length: n }, () => []);

    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const sim = this.similarity(chunks[i], chunks[j], embeddings[i], embeddings[j]);
        if (sim >= this.threshold) {
          adj[i].push(j);
          adj[j].push(i);
        }
      }
    }

    const labels = Array.from({ length: n }, () => -1);
    let cliqueCount = 0;
    for (let i = 0; i < n; i++) {
      if (labels[i] !== -1) continue;
      const frontier = [i];
      labels[i] = cliqueCount;
      while (frontier.length > 0) {
        const cur = frontier.pop()!;
        for (const nb of adj[cur]) {
          if (labels[nb] === -1) {
            labels[nb] = cliqueCount;
            frontier.push(nb);
          }
        }
      }
      cliqueCount++;
    }

    const groups = new Map<number, number[]>();
    for (let i = 0; i < n; i++) {
      const l = labels[i];
      if (!groups.has(l)) groups.set(l, []);
      groups.get(l)!.push(i);
    }

    const cliques: Clique[] = [];
    for (const [id, memberIdx] of groups.entries()) {
      if (memberIdx.length < this.minSize) continue;
      const memberIds = memberIdx.map(i => chunks[i]);
      cliques.push({
        id,
        memberIds: memberIdx.map(i => String(i)),
        members: memberIds,
        cohesion: this.cohesion(memberIdx, chunks, embeddings),
      });
    }
    return cliques.sort((a, b) => b.cohesion - a.cohesion);
  }

  private similarity(a: string, b: string, va: number[] | null, vb: number[] | null): number {
    if (va && vb && va.length > 0 && vb.length > 0) return cosineSimilarity(va, vb);
    // Embedding-less fallback: Jaccard on keywords.
    const ka = new Set(a.toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 3));
    const kb = new Set(b.toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 3));
    if (ka.size === 0 || kb.size === 0) return 0;
    let inter = 0;
    for (const w of ka) if (kb.has(w)) inter++;
    const union = ka.size + kb.size - inter;
    return union === 0 ? 0 : inter / union;
  }

  private cohesion(memberIdx: number[], chunks: string[], embeddings: (number[] | null)[]): number {
    if (memberIdx.length < 2) return 1;
    let total = 0;
    let count = 0;
    for (let i = 0; i < memberIdx.length; i++) {
      for (let j = i + 1; j < memberIdx.length; j++) {
        total += this.similarity(
          chunks[memberIdx[i]],
          chunks[memberIdx[j]],
          embeddings[memberIdx[i]],
          embeddings[memberIdx[j]],
        );
        count++;
      }
    }
    return count === 0 ? 0 : total / count;
  }
}
