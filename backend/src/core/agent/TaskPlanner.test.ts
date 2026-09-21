import { PLANNER_ACTIONS } from './TaskPlanner';

describe('TaskPlanner actions', () => {
  it('exposes a non-empty action allowlist', () => {
    expect(PLANNER_ACTIONS.length).toBeGreaterThan(20);
    expect(new Set(PLANNER_ACTIONS).size).toBe(PLANNER_ACTIONS.length);
  });

  it('includes the agentic delegation and MCP actions', () => {
    const set = new Set(PLANNER_ACTIONS);
    for (const action of ['delegate', 'mcp_call', 'skill', 'skill_learn']) {
      expect(set.has(action)).toBe(true);
    }
  });

  it('includes the runtime step executors', () => {
    const set = new Set(PLANNER_ACTIONS);
    for (const action of ['repo_run', 'video_produce', 'open_chrome', 'web_search', 'think']) {
      expect(set.has(action)).toBe(true);
    }
  });
});
