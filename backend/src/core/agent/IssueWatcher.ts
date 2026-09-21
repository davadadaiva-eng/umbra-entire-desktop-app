/**
 * IssueWatcher — the "push collaborator" loop: watches configured GitHub
 * repos and turns new open issues into agent tasks.
 *
 * Every poll fetches open issues (GET /repos/{o}/{r}/issues?state=open) with
 * the vault-stored PAT, filters by configured labels / assignee, routes the
 * title through CompanionRegistry, dispatches a task via the injected
 * dispatchTask (the same path as POST /api/chat), and — when the task
 * completes — posts its summary back as an issue comment. Dispatched issue
 * ids persist to a state file, so a restart never re-triggers them.
 *
 * Every collaborator is injected (token resolver, consent gate, companion
 * routing, dispatchTask, fetch), so the class is fully unit-testable without
 * touching GitHub.
 */
import * as fs from 'fs';
import * as path from 'path';
import { getLogger } from '../Logger';

export interface WatchedRepo {
  owner: string;
  repo: string;
  /** Optional local ReposManager repo name so the plan works in the right folder. */
  localName?: string;
}

export interface GithubIssue {
  id: number;
  number: number;
  title: string;
  html_url?: string;
  labels?: { name: string }[];
  assignees?: { login: string }[];
  /** Present when the item is a pull request (the issues endpoint lists them). */
  pull_request?: unknown;
}

export interface IssueWatcherOptions {
  repositories: WatchedRepo[];
  /** Where dispatched-issue state lives (survives restarts). */
  stateFile: string;
  /** Resolve the GitHub PAT; null/empty → watching is disabled that poll. */
  token: () => string | null;
  /** Consent gate — consulted before each dispatch unless consentRequired=false. */
  requestConsent: (reason: string) => Promise<string>;
  /** Route the issue title to a companion id (CompanionRegistry.best). */
  route?: (title: string) => string;
  /** Dispatch a task; resolves to the task id. */
  dispatchTask: (description: string) => Promise<string>;
  /** Poll interval in ms (default 60s). */
  pollIntervalMs?: number;
  /** Only watch issues carrying any of these labels (empty = all open issues). */
  labels?: string[];
  /** Only watch issues assigned to this login (empty = any assignee). */
  assignedTo?: string;
  /** Ask the user before dispatching each issue (default true). */
  consentRequired?: boolean;
  /** Post the completed task summary back as a comment (default true). */
  commentResults?: boolean;
  /** Injectable fetch (defaults to the global fetch). */
  fetch?: typeof fetch;
}

interface DispatchedIssue {
  taskId: string;
  owner: string;
  repo: string;
  number: number;
  dispatchedAt: number;
  commentedAt?: number;
}

export class IssueWatcher {
  private options: IssueWatcherOptions;
  private fetchFn: typeof fetch;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private polling = false;
  private seen = new Map<string, DispatchedIssue>();
  private pending = new Map<string, { owner: string; repo: string; number: number }>();

  constructor(options: IssueWatcherOptions) {
    this.options = options;
    this.fetchFn = options.fetch ?? fetch;
    this.loadState();
  }

  get isRunning(): boolean {
    return this.running;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.timer = setInterval(() => void this.poll(), this.options.pollIntervalMs ?? 60_000);
    void this.poll();
    getLogger().info({ repos: this.options.repositories.length }, 'IssueWatcher started');
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    getLogger().info('IssueWatcher stopped');
  }

  /** Poll every configured repo for new open issues. Never throws. */
  async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      const token = this.options.token();
      if (!token) {
        getLogger().warn('IssueWatcher: no GitHub token in the credential vault — configure one to enable watching');
        return;
      }
      for (const repo of this.options.repositories) {
        try {
          await this.pollRepo(token, repo);
        } catch (err: any) {
          getLogger().warn({ repo: `${repo.owner}/${repo.repo}`, err: err.message }, 'IssueWatcher: repo poll failed');
        }
      }
    } catch (err: any) {
      getLogger().debug({ err: err.message }, 'IssueWatcher poll error');
    } finally {
      this.polling = false;
    }
  }

  /**
   * Called when a dispatched task finishes — posts the summary back to the
   * issue and clears the pending slot. Wired to the task:completed event in
   * the composition root.
   */
  async postResult(taskId: string, summary: string): Promise<void> {
    const pending = this.pending.get(taskId);
    if (!pending) return;
    this.pending.delete(taskId);
    const comment = `Umbra handled this issue.\n\n${String(summary || '').slice(0, 2000)}`;
    try {
      if (this.options.commentResults !== false) {
        await this.postComment(pending, comment);
      }
      const entry = this.seen.get(this.key(pending.owner, pending.repo, pending.number));
      if (entry) entry.commentedAt = Date.now();
      this.saveState();
    } catch (err: any) {
      getLogger().warn({ taskId, err: err.message }, 'IssueWatcher: could not post result comment');
    }
  }

  private async pollRepo(token: string, repo: WatchedRepo): Promise<void> {
    const url = `https://api.github.com/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}/issues?state=open&per_page=100`;
    const res = await this.fetchFn(url, {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'umbra-os',
      },
    });
    if (!res.ok) {
      getLogger().warn({ repo: `${repo.owner}/${repo.repo}`, status: res.status }, 'IssueWatcher: issues fetch failed');
      return;
    }
    const issues = (await res.json()) as GithubIssue[];
    for (const issue of issues) {
      const key = this.key(repo.owner, repo.repo, issue.number);
      if (this.seen.has(key)) continue;
      if (issue.pull_request) {
        // The issues endpoint lists pull requests too — never dispatch those.
        this.seen.set(key, { taskId: '', owner: repo.owner, repo: repo.repo, number: issue.number, dispatchedAt: Date.now() });
        this.saveState();
        continue;
      }
      if (!this.matchesFilters(issue)) continue;
      await this.handleIssue(repo, issue);
    }
  }

  private matchesFilters(issue: GithubIssue): boolean {
    const labels = this.options.labels ?? [];
    if (labels.length > 0) {
      const names = new Set((issue.labels ?? []).map(l => l.name));
      if (!labels.some(l => names.has(l))) return false;
    }
    if (this.options.assignedTo) {
      const logins = new Set((issue.assignees ?? []).map(a => a.login));
      if (!logins.has(this.options.assignedTo)) return false;
    }
    return true;
  }

  private async handleIssue(repo: WatchedRepo, issue: GithubIssue): Promise<void> {
    const reason = `Auto-handle GitHub issue #${issue.number} in ${repo.owner}/${repo.repo}: ${issue.title}`;
    if (this.options.consentRequired !== false) {
      const result = await this.options.requestConsent(reason);
      if (result !== 'granted') {
        getLogger().warn({ issue: `${repo.owner}/${repo.repo}#${issue.number}` }, 'IssueWatcher: issue skipped — consent denied');
        return;
      }
    }

    const companionId = this.options.route ? this.options.route(issue.title) : 'assistant';
    const description = [
      `GitHub issue ${repo.owner}/${repo.repo}#${issue.number}: ${issue.title}`,
      repo.localName ? `Work in the local repo "${repo.localName}" (use repo_read/repo_write/repo_run).` : '',
      companionId !== 'assistant' ? `Routed to the ${companionId} companion.` : '',
    ].filter(Boolean).join(' ');

    const taskId = await this.options.dispatchTask(description);
    const key = this.key(repo.owner, repo.repo, issue.number);
    this.seen.set(key, { taskId, owner: repo.owner, repo: repo.repo, number: issue.number, dispatchedAt: Date.now() });
    this.pending.set(taskId, { owner: repo.owner, repo: repo.repo, number: issue.number });
    this.saveState();
    getLogger().info(
      { issue: `${repo.owner}/${repo.repo}#${issue.number}`, taskId, companion: companionId },
      'IssueWatcher: dispatched issue as task',
    );
  }

  private async postComment(target: { owner: string; repo: string; number: number }, body: string): Promise<void> {
    const token = this.options.token();
    if (!token) return;
    const url = `https://api.github.com/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}/issues/${target.number}/comments`;
    const res = await this.fetchFn(url, {
      method: 'POST',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'umbra-os',
      },
      body: JSON.stringify({ body }),
    });
    if (!res.ok) {
      throw new Error(`GitHub comment failed: HTTP ${res.status}`);
    }
  }

  private key(owner: string, repo: string, number: number): string {
    return `${owner}/${repo}#${number}`;
  }

  private loadState(): void {
    try {
      if (!fs.existsSync(this.options.stateFile)) return;
      const parsed = JSON.parse(fs.readFileSync(this.options.stateFile, 'utf8'));
      if (parsed && typeof parsed === 'object') {
        for (const [key, entry] of Object.entries(parsed)) {
          this.seen.set(key, entry as DispatchedIssue);
        }
      }
    } catch {
      // Corrupt state is non-fatal — worst case an issue re-dispatches once.
    }
  }

  private saveState(): void {
    try {
      fs.mkdirSync(path.dirname(this.options.stateFile), { recursive: true });
      fs.writeFileSync(this.options.stateFile, JSON.stringify(Object.fromEntries(this.seen), null, 2));
    } catch {
      // Best-effort persistence.
    }
  }
}
