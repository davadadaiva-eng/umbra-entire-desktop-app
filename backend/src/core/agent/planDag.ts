/**
 * planDag — dependency-DAG helpers for plan execution.
 *
 * The planner can emit a DAG instead of a flat step list: every step may
 * declare `dependsOn: ["step-1", …]`, so independent steps (research
 * gathers, reads, searches) run in parallel waves and dependent steps
 * (aggregation, writing) join only after their inputs complete. A step with
 * no dependsOn is a root and may run alongside every other root.
 *
 * The two helpers here are pure and deterministic — the runtime uses them to
 * (a) reject malformed plans (missing dependency / cycle) before running
 * anything and (b) group a valid DAG into execution waves. Steps without an
 * explicit id are addressed as `step-<index+1>`, matching the planner's
 * normalization.
 */
import type { PlannedStep } from './TaskPlanner';

/** A step's dependency id — explicit id, else `step-<index+1>`. */
export function planStepId(step: PlannedStep, index: number): string {
  return step.id || `step-${index + 1}`;
}

/** Assign stable ids to steps the planner emitted without one. */
export function normalizePlanSteps(steps: PlannedStep[]): PlannedStep[] {
  return steps.map((s, i) => (s.id ? s : { ...s, id: `step-${i + 1}` }));
}

/**
 * Validate a plan DAG. Returns an error message when the plan cannot run as
 * a DAG (missing dependency, duplicate id, or a dependency cycle), or null
 * when it is safe to execute in waves.
 */
export function validatePlanDag(steps: PlannedStep[]): string | null {
  const byId = new Map<string, number>();
  steps.forEach((s, i) => {
    const id = planStepId(s, i);
    if (!byId.has(id)) byId.set(id, i);
  });

  for (let i = 0; i < steps.length; i++) {
    for (const dep of steps[i].dependsOn ?? []) {
      if (!byId.has(dep)) {
        return `Plan step ${i + 1} ("${steps[i].description || steps[i].action}") depends on unknown step "${dep}"`;
      }
    }
  }

  // Cycle detection via Kahn's algorithm (also catches self-dependencies).
  const dependents = steps.map(() => new Set<number>());
  const inDegree = steps.map(() => 0);
  steps.forEach((s, i) => {
    for (const dep of s.dependsOn ?? []) {
      const j = byId.get(dep);
      if (j === undefined) continue;
      dependents[j].add(i);
      inDegree[i]++;
    }
  });
  const ready = steps.map((_, i) => i).filter(i => inDegree[i] === 0);
  let processed = 0;
  while (ready.length > 0) {
    const i = ready.pop()!;
    processed++;
    for (const j of dependents[i]) {
      inDegree[j]--;
      if (inDegree[j] === 0) ready.push(j);
    }
  }
  if (processed < steps.length) return 'Plan contains a dependency cycle';
  return null;
}

/**
 * Group a validated plan into execution waves: every step whose dependencies
 * all completed in earlier waves runs in the same wave, so the runtime can
 * execute each wave's steps concurrently. Assumes the plan passed
 * validatePlanDag — a cycle would silently drop the stuck steps.
 */
export function groupPlanWaves(steps: PlannedStep[]): number[][] {
  const byId = new Map<string, number>();
  steps.forEach((s, i) => {
    const id = planStepId(s, i);
    if (!byId.has(id)) byId.set(id, i);
  });
  const dependents = steps.map(() => new Set<number>());
  const inDegree = steps.map(() => 0);
  steps.forEach((s, i) => {
    for (const dep of s.dependsOn ?? []) {
      const j = byId.get(dep);
      if (j === undefined || j === i) continue;
      dependents[j].add(i);
      inDegree[i]++;
    }
  });
  const ready = steps.map((_, i) => i).filter(i => inDegree[i] === 0);
  const waves: number[][] = [];
  while (ready.length > 0) {
    const wave = [...ready].sort((a, b) => a - b);
    ready.length = 0;
    for (const i of wave) {
      for (const j of dependents[i]) {
        inDegree[j]--;
        if (inDegree[j] === 0) ready.push(j);
      }
    }
    waves.push(wave);
  }
  return waves;
}
