import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { execSync } from 'child_process';
import { ReposManager } from './ReposManager';

describe('ReposManager', () => {
  let root: string;
  let repoDir: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'umbra-repos-'));
    repoDir = path.join(root, 'my-repo');
    fs.mkdirSync(repoDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function makeRepo(): ReposManager {
    return new ReposManager([{ name: 'my-repo', path: repoDir }]);
  }

  describe('registration', () => {
    it('registers repos from constructor config', () => {
      const repos = makeRepo();
      expect(repos.listConfigs()).toEqual([{ name: 'my-repo', path: repoDir }]);
    });

    it('normalizes names (lowercase, slashes become dashes)', () => {
      const repos = new ReposManager([{ name: 'My/Repo.Name', path: repoDir }]);
      expect(repos.listConfigs()[0].name).toBe('my-repo.name');
      expect(repos.resolveRepo('my-repo.name')).toBeDefined();
    });

    it('rejects empty names', () => {
      expect(() => new ReposManager([{ name: '', path: repoDir }])).toThrow(/non-empty/);
    });

    it('warns but registers a non-existent path', () => {
      const repos = new ReposManager([{ name: 'ghost', path: path.join(root, 'nope') }]);
      expect(repos.resolveRepo('ghost').path).toContain('nope');
      expect(repos.gitStatus('ghost')).resolves.toMatchObject({ exists: false, isGit: false });
    });
  });

  describe('resolveRepo', () => {
    it('resolves by registered name', () => {
      expect(makeRepo().resolveRepo('my-repo').path).toBe(repoDir);
    });

    it('resolves by absolute path', () => {
      expect(makeRepo().resolveRepo(repoDir).path).toBe(repoDir);
    });

    it('resolves by subpath of a registered repo', () => {
      expect(makeRepo().resolveRepo(path.join(repoDir, 'src')).name).toBe('my-repo');
    });

    it('throws for unknown repos and lists registered ones', () => {
      expect(() => makeRepo().resolveRepo('nope')).toThrow(/Unknown repo: nope/);
      expect(() => makeRepo().resolveRepo('nope')).toThrow(/my-repo/);
    });
  });

  describe('file operations', () => {
    it('writes and reads back a file', async () => {
      const repos = makeRepo();
      const result = await repos.write('my-repo', 'src/a.txt', 'hello umbra');
      expect(result).toEqual({ path: 'src/a.txt', bytes: 11 });
      expect(await repos.read('my-repo', 'src/a.txt')).toBe('hello umbra');
    });

    it('creates nested directories automatically', async () => {
      await makeRepo().write('my-repo', 'a/b/c/deep.txt', 'x');
      expect(fs.existsSync(path.join(repoDir, 'a/b/c/deep.txt'))).toBe(true);
    });

    it('lists contents with directories marked by trailing slash', async () => {
      const repos = makeRepo();
      await repos.write('my-repo', 'a.txt', '1');
      await repos.write('my-repo', 'sub/b.txt', '2');
      const list = await repos.list('my-repo');
      expect(list).toContain('a.txt');
      expect(list).toContain('sub/');
      expect(await repos.list('my-repo', 'sub')).toEqual(['b.txt']);
    });

    it('blocks path traversal', async () => {
      const repos = makeRepo();
      await expect(repos.read('my-repo', '..\\outside.txt')).rejects.toThrow(/escapes repo/);
      await expect(repos.read('my-repo', '../../etc/passwd')).rejects.toThrow(/escapes repo/);
      await expect(repos.write('my-repo', '..\\outside.txt', 'x')).rejects.toThrow(/escapes repo/);
      expect(fs.existsSync(path.join(root, 'outside.txt'))).toBe(false);
    });

    it('throws when reading a missing file', async () => {
      await expect(makeRepo().read('my-repo', 'missing.txt')).rejects.toThrow(/ENOENT/);
    });

    it('refuses to read files over the size cap', async () => {
      fs.writeFileSync(path.join(repoDir, 'big.bin'), 'x'.repeat(1024 * 1024 + 1));
      await expect(makeRepo().read('my-repo', 'big.bin')).rejects.toThrow(/too large/);
    });
  });

  describe('run', () => {
    it('executes a command in the repo root', async () => {
      const res = await makeRepo().run('my-repo', 'echo hi > created-by-run.txt');
      expect(res.code).toBe(0);
      expect(fs.existsSync(path.join(repoDir, 'created-by-run.txt'))).toBe(true);
      expect(fs.readFileSync(path.join(repoDir, 'created-by-run.txt'), 'utf8').trim()).toBe('hi');
    });

    it('returns stderr and a non-zero code on failure', async () => {
      const res = await makeRepo().run('my-repo', 'echo boom 1>&2 & exit 7');
      expect(res.code).toBe(7);
      expect(res.stderr).toContain('boom');
    });

    it('truncates huge output', async () => {
      const res = await makeRepo().run('my-repo', 'for /L %i in (1,1,40000) do @echo line %i');
      expect(res.code).toBe(0);
      expect(res.stdout.length).toBeLessThanOrEqual(256 * 1024 + 500);
      expect(res.stdout).toContain('[truncated');
    });
  });

  describe('gitStatus', () => {
    function initGitRepo(): void {
      execSync('git init -q', { cwd: repoDir });
      execSync('git config user.name Test', { cwd: repoDir });
      execSync('git config user.email test@example.com', { cwd: repoDir });
      fs.writeFileSync(path.join(repoDir, 'file.txt'), 'v1');
      execSync('git add . && git commit -qm init', { cwd: repoDir });
    }

    it('reports a clean git repo with branch and last commit', async () => {
      initGitRepo();
      const status = await makeRepo().gitStatus('my-repo');
      expect(status.exists).toBe(true);
      expect(status.isGit).toBe(true);
      expect(status.branch).toBeTruthy();
      expect(status.lastCommit).toMatch(/init/);
      expect(status.dirty).toBe(0);
    });

    it('counts dirty files', async () => {
      initGitRepo();
      fs.writeFileSync(path.join(repoDir, 'file.txt'), 'v2');
      fs.writeFileSync(path.join(repoDir, 'new.txt'), 'x');
      const status = await makeRepo().gitStatus('my-repo');
      expect(status.dirty).toBeGreaterThanOrEqual(2);
    });

    it('flags non-git directories', async () => {
      const status = await makeRepo().gitStatus('my-repo');
      expect(status.isGit).toBe(false);
      expect(status.branch).toBeNull();
      expect(status.lastCommit).toBeNull();
    });

    it('statusAll returns one entry per repo', async () => {
      initGitRepo();
      const repos = new ReposManager([
        { name: 'one', path: repoDir },
        { name: 'two', path: path.join(root, 'plain') },
      ]);
      const all = await repos.statusAll();
      expect(all).toHaveLength(2);
      expect(all[0].isGit).toBe(true);
      expect(all[1].isGit).toBe(false);
    });
  });

  describe('openInEditor', () => {
    it('always returns a command and args', () => {
      const { command, args } = makeRepo().openInEditor('my-repo');
      expect(command.length).toBeGreaterThan(0);
      expect(Array.isArray(args)).toBe(true);
      expect(args).toContain(repoDir);
    });
  });
});
