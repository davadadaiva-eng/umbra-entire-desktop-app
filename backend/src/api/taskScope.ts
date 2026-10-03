/**
 * taskScope — anti-confusion guards for task-bound routes.
 *
 * Modeled on OpenDots `runtime-scope.ts`: route IDs and body IDs that refer
 * to the same task/proposal must agree, otherwise the request is rejected
 * with 403 instead of acting on the wrong object.
 *
 * New isolated helpers — no route wiring yet, no behavior change.
 */
import { AppError } from './AppError';

const MAX_ID_LENGTH = 256;

/** Reject empty IDs and IDs containing path separators/whitespace. */
export function assertSafeId(value: string, name: string): string {
  const id = value;
  if (
    !id ||
    id.length > MAX_ID_LENGTH ||
    /[/\\\s]/.test(id)
  ) {
    throw new AppError(`${name} is not valid`, 403);
  }
  return id;
}

/**
 * The `taskId` in the URL and the `taskId` in the JSON body (when present)
 * must match. Used by routes like POST /api/input/:inputId/answer where the
 * taskId travels in the body while the inputId travels in the path.
 */
export function assertTaskBinding(
  routeTaskId: string | undefined,
  bodyTaskId: unknown,
  field = 'taskId',
): void {
  if (bodyTaskId === undefined || bodyTaskId === '') return;
  if (typeof bodyTaskId !== 'string') {
    throw new AppError(`${field} is not valid`, 403);
  }
  assertSafeId(bodyTaskId, field);
  if (routeTaskId !== undefined && bodyTaskId !== routeTaskId) {
    throw new AppError(
      'This request does not belong to the given task',
      403,
    );
  }
}

/**
 * A loaded proposal/input carries the task it was created for. Callers pass
 * the owning taskId (when known) and the taskId the route claims — mismatch
 * is a 403. Unknown owner (undefined) is allowed so read-only nodes without
 * the store can still serve.
 */
export function assertOwnerBinding(
  ownerTaskId: string | undefined,
  routeTaskId: string | undefined,
  what = 'proposal',
): void {
  if (ownerTaskId === undefined || routeTaskId === undefined) return;
  if (ownerTaskId !== routeTaskId) {
    throw new AppError(
      `This ${what} does not belong to the given task`,
      403,
    );
  }
}
