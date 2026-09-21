import { validatePlanDag, groupPlanWaves, normalizePlanSteps } from './planDag';
import type { PlannedStep } from './TaskPlanner';
import { TaskPlanner } from './TaskPlanner';

function step(id: string, dependsOn: string[] = []): PlannedStep {
  return { id, description: id, action: 'think', params: {}, requiresKnowledge: [], dependsOn };
}

describe('planDag', () => {
  it('groups independent steps into a single parallel wave', () => {
    const plan = [step('g1'), step('g2'), step('g3')];
    expect(validatePlanDag(plan)).toBeNull();
    expect(groupPlanWaves(plan)).toEqual([[0, 1, 2]]);
  });

  it('runs a chain strictly sequentially', () => {
    const plan = [step('a'), step('b', ['a']), step('c', ['b'])];
    expect(groupPlanWaves(plan)).toEqual([[0], [1], [2]]);
  });

  it('orders dependent aggregation after its parallel gathers', () => {
    const plan = [step('g1'), step('g2'), step('agg', ['g1', 'g2']), step('write', ['agg'])];
    expect(groupPlanWaves(plan)).toEqual([[0, 1], [2], [3]]);
  });

  it('resolves dependency ids for steps without explicit ids', () => {
    const noId = { description: 'x', action: 'think', params: {}, requiresKnowledge: [] };
    const plan = [noId, { ...noId, dependsOn: ['step-1'] }];
    expect(validatePlanDag(plan)).toBeNull();
    expect(groupPlanWaves(plan)).toEqual([[0], [1]]);
  });

  it('rejects a missing dependency', () => {
    const plan = [step('agg', ['nope'])];
    expect(validatePlanDag(plan)).toContain('unknown step "nope"');
  });

  it('rejects a dependency cycle', () => {
    const plan = [step('a', ['b']), step('b', ['a'])];
    expect(validatePlanDag(plan)).toContain('cycle');
  });

  it('rejects a self-dependency', () => {
    const plan = [step('a', ['a'])];
    expect(validatePlanDag(plan)).toContain('cycle');
  });

  it('normalizePlanSteps assigns stable ids to id-less steps', () => {
    const plan = [{ description: 'x', action: 'think', params: {}, requiresKnowledge: [] }];
    expect(normalizePlanSteps(plan)[0].id).toBe('step-1');
    expect(normalizePlanSteps(plan)).not.toBe(plan);
  });
});

describe('TaskPlanner parallel plans', () => {
  it('keeps dependsOn and assigns ids when parsing a plan with parallel branches', async () => {
    const llm: any = {
      complete: jest.fn(async () => ({
        content: JSON.stringify({
          confidence: 90,
          needsClarification: false,
          estimatedTimeMs: 10000,
          steps: [
            { id: 'g1', description: 'gather a', action: 'web_search', params: { query: 'a' }, requiresKnowledge: [] },
            { id: 'g2', description: 'gather b', action: 'web_search', params: { query: 'b' }, requiresKnowledge: [] },
            { id: 'agg', description: 'aggregate', action: 'think', params: {}, requiresKnowledge: [], dependsOn: ['g1', 'g2'] },
          ],
        }),
      })),
    };
    const knowledge: any = {
      search: jest.fn(async () => []),
      getLinked: jest.fn(async () => []),
      learnFromExecution: async () => {},
    };
    const planner = new TaskPlanner(knowledge, llm);

    const plan = await planner.planTask('t1', 'compare a and b');
    expect(plan.steps).toHaveLength(3);
    expect(plan.steps[2].dependsOn).toEqual(['g1', 'g2']);
    expect(plan.steps.every(s => s.id)).toBe(true);
  });
});
