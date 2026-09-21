import { Caveman, estimateTokens } from './Caveman';
import { Chunker } from './Chunker';
import { Clustering } from './Clustering';
import { GraphSummarizer } from './GraphSummarizer';
import { GraphifyContextEngine } from './GraphifyContextEngine';

describe('Graphify / Caveman token optimization', () => {
  describe('Caveman', () => {
    it('strips filler words and estimates token savings', () => {
      const caveman = new Caveman();
      const original = 'Hello, we would really like to kindly ask you to please review the latest pull request.';
      const compressed = caveman.compress(original);
      expect(compressed.length).toBeLessThan(original.length);
      expect(caveman.savingsRatio(original, compressed)).toBeGreaterThan(0);
    });

    it('enforces max length', () => {
      const caveman = new Caveman({ maxLength: 30 });
      const out = caveman.compress('A very long sentence that should definitely be truncated to the maximum length.');
      expect(out.length).toBeLessThanOrEqual(31);
    });

    it('estimateTokens is monotonic with length', () => {
      expect(estimateTokens('short')).toBeLessThan(estimateTokens('a significantly longer piece of prose here'));
    });
  });

  describe('Chunker', () => {
    it('splits long text into bounded chunks with overlap', () => {
      const chunker = new Chunker({ chunkTokens: 200 });
      const longText = ('paragraph one with enough words. '.repeat(200)) + '\n\n' + ('paragraph two. '.repeat(200));
      const chunks = chunker.chunk(longText);
      expect(chunks.length).toBeGreaterThan(1);
      for (const chunk of chunks) expect(chunk.tokens).toBeLessThanOrEqual(600);
      expect(chunks[0].id).toMatch(/^c/);
    });
  });

  describe('Clustering', () => {
    it('groups similar chunks into cliques', () => {
      const clustering = new Clustering({ threshold: 0.3 });
      const chunks = [
        'Quarterly revenue report shows strong increase across all regions.',
        'Quarterly revenue report shows strong increase across most regions.',
        'The cat sat on the mat and purred contentedly.',
        'A cat sat on the mat and purred quietly.',
      ];
      const cliques = clustering.cluster(chunks, [null, null, null, null]);
      expect(cliques.length).toBeGreaterThanOrEqual(2);
      const revenue = cliques.find(c => c.members.some(m => m.includes('revenue')));
      expect(revenue?.members.some(m => m.includes('across'))).toBe(true);
    });
  });

  describe('GraphSummarizer', () => {
    it('produces an extractive summary without an LLM', () => {
      const summarizer = new GraphSummarizer();
      const text = 'Alpha beta gamma. ' .repeat(60);
      const summary = summarizer.extractive(text, 100);
      expect(summary.length).toBeGreaterThan(0);
      expect(summary.length).toBeLessThan(text.length);
    });
  });

  describe('GraphifyContextEngine', () => {
    it('compresses large context and reports savings', async () => {
      const engine = new GraphifyContextEngine();
      const big = ('The quick brown fox jumps over the lazy dog and continues its journey across the meadow. ').repeat(60);
      const result = await engine.compress(big);
      expect(result.prompt.length).toBeGreaterThan(0);
      expect(result.originalTokens).toBeGreaterThan(result.promptTokens);
      expect(result.savings).toBeGreaterThan(0);
      expect(result.cliques.length).toBeGreaterThanOrEqual(1);
    });

    it('can expand a clique back to near-verbatim context', async () => {
      const engine = new GraphifyContextEngine();
      const result = await engine.compress('UniqueA content about quantum computing. '.repeat(40) + 'UniqueB about gardening. '.repeat(40));
      const expanded = await engine.expandClique(result, result.cliques[0].id);
      expect(expanded.length).toBeGreaterThan(0);
    });

    it('uses provided embeddings when available', async () => {
      const engine = new GraphifyContextEngine({
        targetChunkTokens: 50,
        embeddings: (chunk) => chunk.includes('garden') ? [1, 0, 0] : [0, 1, 0],
      });
      const result = await engine.compress('gardening tips for tomatoes. '.repeat(30) + 'stock trading analysis. '.repeat(30));
      expect(result.cliques.length).toBeGreaterThanOrEqual(2);
    });
  });
});
