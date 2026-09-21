/**
 * Chunker — splits raw context (chat logs, code, memory fragments) into
 * semantic nodes sized for embedding. Step 1 of the Graphify pipeline.
 */

export interface Chunk {
  id: string;
  text: string;
  tokens: number;
  source: string;
}

export interface ChunkerOptions {
  chunkTokens?: number;
  overlapChars?: number;
  /** Split markers where a new chunk is forced (paragraphs, headers). */
  splitMarkers?: RegExp;
}

export class Chunker {
  private chunkTokens: number;
  private overlapChars: number;
  private splitMarkers: RegExp;

  constructor(options: ChunkerOptions = {}) {
    this.chunkTokens = options.chunkTokens ?? 400;
    this.overlapChars = options.overlapChars ?? 80;
    this.splitMarkers = options.splitMarkers ?? /(\n{2,}|^#{1,6}\s)/m;
  }

  chunk(text: string, source = 'context'): Chunk[] {
    const nodes = this.initialSplit(text);
    const out: Chunk[] = [];
    let counter = 0;
    for (const node of nodes) {
      for (const piece of this.subdivide(node)) {
        const trimmed = piece.trim();
        if (!trimmed) continue;
        out.push({
          id: `c${++counter}-${source.replace(/[^a-z0-9]/gi, '_').slice(0, 20)}`,
          text: trimmed,
          tokens: this.approxTokens(trimmed),
          source,
        });
      }
    }
    return out;
  }

  private initialSplit(text: string): string[] {
    // Split on hard structural markers first, then merge back to ~chunk size.
    const parts = text.split(this.splitMarkers);
    const merged: string[] = [];
    let current = '';
    for (const part of parts) {
      if (this.approxTokens(current) + this.approxTokens(part) <= this.chunkTokens * 1.5 || !current) {
        current += part;
      } else {
        merged.push(current);
        current = part;
      }
    }
    if (current) merged.push(current);
    return merged;
  }

  private subdivide(text: string): string[] {
    const pieces: string[] = [];
    const target = this.chunkTokens * 4; // approx chars
    if (text.length <= target) {
      pieces.push(text);
      return pieces;
    }
    let start = 0;
    while (start < text.length) {
      let end = Math.min(start + target, text.length);
      if (end < text.length) {
        const boundary = text.lastIndexOf(' ', end);
        if (boundary > start + target / 2) end = boundary;
      } else {
        // Last piece — emit and stop (no shriveling overlap tails).
        pieces.push(text.substring(start, end));
        break;
      }
      pieces.push(text.substring(start, end));
      start = Math.max(end - this.overlapChars, start + 1);
    }
    return pieces;
  }

  private approxTokens(text: string): number {
    return Math.max(1, Math.ceil(text.replace(/\s+/g, ' ').length / 4));
  }
}
