import { isSample, workspaceMode } from './mode';

describe('workspace mode', () => {
  it("defaults to live when the env var is absent", () => {
    expect(workspaceMode({} as NodeJS.ProcessEnv)).toBe('live');
    expect(isSample({} as NodeJS.ProcessEnv)).toBe(false);
  });

  it("returns sample only for the exact value 'sample'", () => {
    expect(workspaceMode({ UMBRA_WORKSPACE_MODE: 'sample' } as NodeJS.ProcessEnv)).toBe('sample');
    expect(workspaceMode({ UMBRA_WORKSPACE_MODE: 'SAMPLE' } as NodeJS.ProcessEnv)).toBe('live');
    expect(workspaceMode({ UMBRA_WORKSPACE_MODE: '' } as NodeJS.ProcessEnv)).toBe('live');
  });
});
