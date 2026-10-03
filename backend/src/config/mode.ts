/**
 * Workspace mode — sample vs live.
 *
 * `UMBRA_WORKSPACE_MODE=sample` serves fictional data with no keys, model,
 * Google, or Docker required. `live` (default) requires real configuration.
 * Same API shape in both modes; callers branch on `isSample()`.
 *
 * Pure helper, no wiring yet — routes adopt it per endpoint later.
 */
export type WorkspaceMode = 'sample' | 'live';

export function workspaceMode(env: NodeJS.ProcessEnv = process.env): WorkspaceMode {
  return env['UMBRA_WORKSPACE_MODE'] === 'sample' ? 'sample' : 'live';
}

export function isSample(env: NodeJS.ProcessEnv = process.env): boolean {
  return workspaceMode(env) === 'sample';
}
