/**
 * SkillContentIndex — indexes every SKILL.md across the cloned skill-pack
 * repos under `external/skills/` and resolves a catalog skill to its full
 * instructions, so a routed skill can inject the repo-authored guidance
 * instead of only the one-line catalog purpose.
 */

import * as fs from 'fs';
import * as path from 'path';
import { listSkillRepos, SkillRepo } from './SkillRepos';

export interface IndexedSkill {
  /** `name:` from the SKILL.md frontmatter, or the containing directory. */
  name: string;
  /** Repo it was loaded from (e.g. `Leonxlnx/taste-skill`). */
  repo: string;
  description?: string;
  /** Frontmatter-stripped body. */
  content: string;
}

const MAX_CONTENT_CHARS = 6000;
const MAX_BUNDLE_CHARS = 8000;

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/** Collect all SKILL.md files under a repo root (recursive, depth-limited). */
export function listSkillMdFiles(dir: string, maxDepth = 6): string[] {
  const out: string[] = [];
  const stack: Array<[string, number]> = [[dir, 0]];
  while (stack.length) {
    const [d, depth] = stack.pop()!;
    if (depth > maxDepth) continue;
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const abs = path.join(d, entry.name);
      if (entry.isFile() && entry.name.toLowerCase() === 'skill.md') out.push(abs);
      else if (entry.isDirectory()) stack.push([abs, depth + 1]);
    }
  }
  return out;
}

export function parseFrontmatter(content: string): { name?: string; description?: string; body: string } {
  if (!content.startsWith('---')) return { body: content };
  const end = content.indexOf('\n---', 3);
  if (end < 0) return { body: content };
  const fm = content.slice(3, end);
  const body = content.slice(end + 4).replace(/^\r?\n/, '');
  const out: { name?: string; description?: string } = {};
  for (const line of fm.split(/\r?\n/)) {
    const m = line.match(/^(name|description)\s*:\s*(.+)$/);
    if (m) out[m[1] as 'name' | 'description'] = m[2].trim();
  }
  return { ...out, body };
}

export class SkillContentIndex {
  private byName = new Map<string, IndexedSkill>();
  private byRepo = new Map<string, IndexedSkill[]>();

  constructor(repos: SkillRepo[] = listSkillRepos()) {
    for (const repo of repos) {
      if (!repo.exists || repo.skillMdCount === 0) continue;
      const files = listSkillMdFiles(repo.repoPath);
      const entries: IndexedSkill[] = [];
      for (const file of files) {
        try {
          const raw = fs.readFileSync(file, 'utf8');
          const { name, description, body } = parseFrontmatter(raw);
          const entryName = name || path.basename(path.dirname(file));
          const entry: IndexedSkill = {
            name: entryName,
            repo: repo.repo,
            description,
            content: body.trim().slice(0, MAX_CONTENT_CHARS),
          };
          entries.push(entry);
          this.byName.set(normalize(entryName), entry);
        } catch { /* skip unreadable file */ }
      }
      this.byRepo.set(normalize(repo.repo), entries);
    }
  }

  get size(): number {
    return this.byName.size;
  }

  /** All indexed skills, for status/inspection. */
  list(): Array<{ name: string; repo: string; description?: string; chars: number }> {
    return [...this.byName.values()].map(s => ({
      name: s.name,
      repo: s.repo,
      description: s.description,
      chars: s.content.length,
    }));
  }

  /**
   * Resolve a catalog skill (id + name) to its full instructions.
   *
   * 1. Exact/partial name match against indexed SKILL.md names.
   * 2. Repo-level match (repo name contains the skill name) → bundle that
   *    repo's SKILL.md files (capped).
   */
  lookup(skillId: string, skillName: string): string | null {
    const keys: string[] = [];
    const n = normalize(skillName);
    if (n) keys.push(n);
    // Also try the domain prefix stripped from the id (e.g. `frontend.taste-skill` → `taste-skill`).
    const idName = normalize(skillId.split('.').slice(1).join('.'));
    if (idName && idName !== n) keys.push(idName);

    // 1. Name-level match.
    for (const key of keys) {
      const exact = this.byName.get(key);
      if (exact) return exact.content;

      // Partial: indexed name contains key, or key contains indexed name.
      let best: IndexedSkill | undefined;
      for (const [cand, entry] of this.byName) {
        if (cand.includes(key) || key.includes(cand)) {
          if (!best || cand.length > normalize(best.name).length) best = entry;
        }
      }
      if (best) return best.content;
    }

    // 2. Repo-level match (bundle the whole repo's guidance).
    for (const key of keys) {
      for (const [repoKey, entries] of this.byRepo) {
        if (repoKey.includes(key) || key.includes(repoKey)) {
          const parts: string[] = [];
          let used = 0;
          for (const entry of entries) {
            if (used + entry.content.length > MAX_BUNDLE_CHARS) break;
            parts.push(`## ${entry.name}\n${entry.content}`);
            used += entry.content.length + 32;
          }
          return parts.length ? parts.join('\n\n') : null;
        }
      }
    }

    return null;
  }
}
