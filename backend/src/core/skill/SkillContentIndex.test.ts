import { SkillContentIndex, listSkillMdFiles, parseFrontmatter } from './SkillContentIndex';
import { listSkillRepos } from './SkillRepos';

describe('SkillContentIndex', () => {
  it('indexes the cloned SKILL.md files (207 files → ≥150 unique names)', () => {
    const index = new SkillContentIndex();
    // cognee has no SKILL.md; the other 9 repos carry 207 files, some sharing
    // frontmatter names, so the unique-name index is slightly smaller.
    expect(index.size).toBeGreaterThanOrEqual(150);
  });

  it('resolves a catalog skill name to its full instructions', () => {
    const index = new SkillContentIndex();
    const content = index.lookup('video.remotion-superpowers', 'remotion-superpowers');
    expect(content).toBeTruthy();
    expect(content!.length).toBeGreaterThan(200);
  });

  it('falls back to a repo-level bundle for taste-skill', () => {
    const index = new SkillContentIndex();
    const content = index.lookup('frontend.taste-skill', 'taste-skill');
    expect(content).toBeTruthy();
  });

  it('returns null for an unknown skill', () => {
    const index = new SkillContentIndex();
    expect(index.lookup('does.not-exist-xyz', 'not-exist-xyz')).toBeNull();
  });
});

describe('parseFrontmatter', () => {
  it('extracts name/description and strips the frontmatter block', () => {
    const parsed = parseFrontmatter('---\nname: animate\ndescription: Build an animation.\n---\n\n# Body\ncontent here');
    expect(parsed.name).toBe('animate');
    expect(parsed.description).toBe('Build an animation.');
    expect(parsed.body).toContain('# Body');
    expect(parsed.body).not.toContain('name:');
  });
});

describe('listSkillMdFiles', () => {
  it('finds SKILL.md files recursively under a cloned repo', () => {
    const repo = listSkillRepos().find(r => r.repo === 'Leonxlnx/taste-skill');
    if (!repo || !repo.exists) return;
    const files = listSkillMdFiles(repo.repoPath);
    expect(files.length).toBeGreaterThan(0);
    expect(files.every(f => f.toLowerCase().endsWith('skill.md'))).toBe(true);
  });
});
