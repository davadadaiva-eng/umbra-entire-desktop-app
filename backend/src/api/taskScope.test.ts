/**
 * taskScope tests — offline, pure helpers only.
 */
import { AppError } from './AppError';
import {
  assertOwnerBinding,
  assertSafeId,
  assertTaskBinding,
} from './taskScope';

function statusOf(fn: () => void): number | null {
  try {
    fn();
    return null;
  } catch (err) {
    expect(err).toBeInstanceOf(AppError);
    return (err as AppError).status;
  }
}

describe('assertSafeId', () => {
  it('accepts normal ids', () => {
    expect(assertSafeId('t-1', 'taskId')).toBe('t-1');
  });

  it('rejects empty, spaced, and slashed ids with 403', () => {
    expect(statusOf(() => assertSafeId('', 'taskId'))).toBe(403);
    expect(statusOf(() => assertSafeId('a b', 'taskId'))).toBe(403);
    expect(statusOf(() => assertSafeId('a/b', 'taskId'))).toBe(403);
    expect(statusOf(() => assertSafeId('a\\b', 'taskId'))).toBe(403);
  });
});

describe('assertTaskBinding', () => {
  it('allows missing body taskId', () => {
    expect(() =>
      assertTaskBinding('t-1', undefined),
    ).not.toThrow();
  });

  it('allows matching ids', () => {
    expect(() =>
      assertTaskBinding('t-1', 't-1'),
    ).not.toThrow();
  });

  it('rejects mismatched ids with 403', () => {
    expect(statusOf(() => assertTaskBinding('t-1', 't-2'))).toBe(403);
  });

  it('rejects non-string body ids with 403', () => {
    expect(statusOf(() => assertTaskBinding('t-1', 42 as unknown as string))).toBe(403);
  });
});

describe('assertOwnerBinding', () => {
  it('allows unknown owners (read-only nodes)', () => {
    expect(() =>
      assertOwnerBinding(undefined, 't-1'),
    ).not.toThrow();
  });

  it('rejects proposals from another task with 403', () => {
    expect(statusOf(() => assertOwnerBinding('t-1', 't-2'))).toBe(403);
  });
});
