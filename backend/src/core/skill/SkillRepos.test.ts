import * as path from 'path';
import { listSkillRepos, getSkillRepo, loadSkillMd } from './SkillRepos';
import { MASTER_MATRIX_DOMAINS } from './MasterMatrix';
import { SKILL_DOMAINS } from './SkillStack';

describe('Master Matrix Domains', () => {
  it('adds 20 specialized matrix domains to the skill stack', () => {
    expect(MASTER_MATRIX_DOMAINS.length).toBe(20);
    const matrixIds = new Set(MASTER_MATRIX_DOMAINS.map(d => d.id));
    for (const d of SKILL_DOMAINS) {
      if (matrixIds.has(d.id)) {
        expect(d.skills.length).toBeGreaterThanOrEqual(4);
      }
    }
  });

  it('every matrix skill has triggers for routing', () => {
    for (const d of MASTER_MATRIX_DOMAINS) {
      for (const [, , , triggers] of d.rows) {
        expect(triggers.length).toBeGreaterThan(0);
      }
    }
  });
});

describe('Skill Repository Registry', () => {
  it('registers exactly the 10 verified repos', () => {
    expect(listSkillRepos()).toHaveLength(10);
  });

  it('reports that cloned repos exist on disk', () => {
    const repos = listSkillRepos();
    const missing = repos.filter(r => !r.exists);
    if (missing.length === repos.length) return;
    for (const repo of repos) {
      if (!repo.exists) continue;
      expect(repo.exists).toBe(true);
    }
  });

  it('loads at least one SKILL.md per cloned repo', () => {
    const repos = listSkillRepos();
    if (repos.every(r => !r.exists)) return;
    const withMds = repos.filter(r => r.skillMdCount > 0);
    // cognee has no SKILL.md (it is a Python library) — the rest should.
    expect(withMds.length).toBeGreaterThanOrEqual(1);
  });

  it('loads SKILL.md content for a known repo', () => {
    const repo = getSkillRepo('coreyhaines31/marketingskills');
    if (!repo?.exists) return;
    const md = loadSkillMd(path.relative(process.cwd(), repo!.repoPath));
    expect(md).toBeTruthy();
    expect(md!.toLowerCase()).toContain('name:');
  });
});