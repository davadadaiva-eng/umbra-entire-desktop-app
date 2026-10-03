/**
 * Computer fence tests — offline, pure functions only.
 */
import {
  assertAgentId,
  assertAllowed,
  assertFileSize,
  assertPdf,
  ComputerFenceError,
  redactSecrets,
  truncateOutput,
  workspacePath,
  COMPUTER_OUTPUT_LIMIT,
} from './fence';

function statusOf(fn: () => void): number | null {
  try {
    fn();
    return null;
  } catch (err) {
    expect(err).toBeInstanceOf(ComputerFenceError);
    return (err as ComputerFenceError).status;
  }
}

describe('workspacePath (Option 2 fence)', () => {
  it('resolves relative paths into the agent drawer', () => {
    expect(workspacePath('leo', 'notes.txt')).toBe('/workspace/agents/leo/notes.txt');
  });

  it('accepts absolute paths inside the drawer', () => {
    expect(workspacePath('leo', '/workspace/agents/leo/a/b.txt')).toBe(
      '/workspace/agents/leo/a/b.txt',
    );
  });

  it('blocks other agents, escapes, and backslashes with 422', () => {
    expect(statusOf(() => workspacePath('leo', '/workspace/agents/mia/x.txt'))).toBe(422);
    expect(statusOf(() => workspacePath('leo', '/workspace/other.txt'))).toBe(422);
    expect(statusOf(() => workspacePath('leo', '../mia/x.txt'))).toBe(422);
    expect(statusOf(() => workspacePath('leo', 'a\\b.txt'))).toBe(422);
    expect(statusOf(() => workspacePath('leo', '/workspace'))).toBe(422);
  });

  it('rejects bad agent ids with 403', () => {
    expect(statusOf(() => workspacePath('../x', 'a.txt'))).toBe(403);
    expect(statusOf(() => assertAgentId(''))).toBe(403);
  });
});

describe('assertAllowed', () => {
  const on = { enabled: true, browser: true, files: true, shell: true };
  it('passes when enabled', () => {
    expect(() => assertAllowed(on, 'shell')).not.toThrow();
  });

  it('blocks disabled computers and missing kinds with 403', () => {
    expect(statusOf(() => assertAllowed({ ...on, enabled: false }, 'shell'))).toBe(403);
    expect(statusOf(() => assertAllowed({ ...on, shell: false }, 'shell'))).toBe(403);
    expect(statusOf(() => assertAllowed({ ...on, browser: false }, 'browser'))).toBe(403);
  });
});

describe('caps and redaction', () => {
  it('truncates oversized output with a flag', () => {
    const big = 'x'.repeat(COMPUTER_OUTPUT_LIMIT + 100);
    const { text, truncated } = truncateOutput(big);
    expect(truncated).toBe(true);
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(COMPUTER_OUTPUT_LIMIT);
    expect(truncateOutput('small').truncated).toBe(false);
  });

  it('rejects oversized files with 413', () => {
    expect(statusOf(() => assertFileSize('x'.repeat(256 * 1024 + 1)))).toBe(413);
  });

  it('validates PDFs with 422', () => {
    const pdf = new Uint8Array([...Buffer.from('%PDF-1.4'), 1, 2, 3]);
    expect(() => assertPdf(pdf)).not.toThrow();
    expect(statusOf(() => assertPdf(new Uint8Array(Buffer.from('hello'))))).toBe(422);
    expect(
      statusOf(() => assertPdf(new Uint8Array(10 * 1024 * 1024 + 1))),
    ).toBe(422);
  });

  it('redacts secrets', () => {
    expect(redactSecrets('key=abc then abc', ['abc', undefined])).toBe(
      'key=[redacted] then [redacted]',
    );
  });
});
