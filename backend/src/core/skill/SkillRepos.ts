/**
 * Skill Repository Registry — maps skill domains to cloned skill-pack repos.
 * Repos follow the agentskills.io convention (SKILL.md files under a folder
 * tree). Anything not on this list is a catalog-only definition.
 */

import * as fs from 'fs';
import * as path from 'path';
import { VERIFIED_MATRIX_REPOS } from './MasterMatrix';

export interface SkillRepo {
  repo: string;
  repoPath: string;
  exists: boolean;
  skillMdCount: number;
}

const BASE = process.cwd();

export function getSkillRepo(repo: string): SkillRepo | undefined {
  const entry = VERIFIED_MATRIX_REPOS[repo];
  if (!entry) return undefined;
  const abs = path.isAbsolute(entry.repoPath) ? entry.repoPath : path.join(BASE, entry.repoPath);
  const exists = fs.existsSync(abs);
  const skillMdCount = exists
    ? countSkillMds(abs)
    : 0;
  return { repo, repoPath: abs, exists, skillMdCount };
}

export function listSkillRepos(): SkillRepo[] {
  return Object.keys(VERIFIED_MATRIX_REPOS).map(getSkillRepo).filter(Boolean) as SkillRepo[];
}

export function countSkillMds(dir: string): number {
  let n = 0;
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) n += countSkillMds(abs);
      else if (entry.isFile() && entry.name.toLowerCase() === 'skill.md') n += 1;
    }
  } catch { /* ignore */ }
  return n;
}

/** Load the first SKILL.md found under a repo (deep search, depth-limited). */
export function loadSkillMd(repoPath: string, maxDepth = 4): string | null {
  const root = path.isAbsolute(repoPath) ? repoPath : path.join(BASE, repoPath);
  const stack: Array<[string, number]> = [[root, 0]];
  while (stack.length) {
    const [dir, depth] = stack.pop()!;
    if (depth > maxDepth) continue;
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      if (entry.isFile() && entry.name.toLowerCase() === 'skill.md') {
        try { return fs.readFileSync(abs, 'utf-8'); } catch { /* next */ }
      }
      if (entry.isDirectory()) stack.push([abs, depth + 1]);
    }
  }
  return null;
}