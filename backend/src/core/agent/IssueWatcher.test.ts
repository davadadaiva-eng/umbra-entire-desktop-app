import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { IssueWatcher, GithubIssue } from './IssueWatcher';

function makeDir(name: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), name));
}

function makeIssue(overrides: Partial<GithubIssue> = {}): GithubIssue {
  return {
    id: Math.floor(Math.random() * 1e9),
    number: 1,
    title: 'Fix the flaky test',
    labels: [],
    assignees: [],
    ...overrides,
  };
}

function makeWatcher(overrides: any = {}) {
  const stateFile = path.join(makeDir('issue-watcher-'), 'state.json');
  const dispatchTask = jest.fn().mockResolvedValue('task-1');
  const requestConsent = jest.fn().mockResolvedValue('granted');
  const route = jest.fn(() => 'ops');
  const fetchFn = jest.fn();
  const watcher = new IssueWatcher({
    repositories: [{ owner: 'acme', repo: 'app' }],
    stateFile,
    token: () => 'ghp_test',
    requestConsent,
    route,
    dispatchTask,
    fetch: fetchFn,
    ...overrides,
  });
  return { watcher, dispatchTask, requestConsent, route, fetchFn, stateFile };
}

const okResponse = (issues: GithubIssue[]) => ({ ok: true, json: async () => issues }) as any;

describe('IssueWatcher', () => {
  it('dispatches a new open issue once and stamps the companion route', async () => {
    const { watcher, dispatchTask, route, fetchFn } = makeWatcher();
    fetchFn.mockResolvedValue(okResponse([makeIssue({ number: 42, title: 'Fix the login bug' })]));

    await watcher.poll();
    await watcher.poll();

    expect(route).toHaveBeenCalledWith('Fix the login bug');
    expect(dispatchTask).toHaveBeenCalledTimes(1);
    expect(dispatchTask).toHaveBeenCalledWith(expect.stringContaining('acme/app#42'));
    expect(dispatchTask).toHaveBeenCalledWith(expect.stringContaining('login bug'));
    expect(dispatchTask).toHaveBeenCalledWith(expect.stringContaining('ops companion'));
  });

  it('marks pull requests as seen without dispatching', async () => {
    const { watcher, dispatchTask, fetchFn } = makeWatcher();
    fetchFn.mockResolvedValue(okResponse([makeIssue({ number: 7, pull_request: { url: 'x' } })]));

    await watcher.poll();
    await watcher.poll();
    expect(dispatchTask).not.toHaveBeenCalled();
  });

  it('filters by labels and assignee', async () => {
    const { watcher, dispatchTask, fetchFn } = makeWatcher({
      labels: ['good-first-issue'],
      assignedTo: 'alice',
    });
    fetchFn.mockResolvedValue(
      okResponse([
        makeIssue({ number: 1, labels: [{ name: 'bug' }], assignees: [{ login: 'alice' }] }),
        makeIssue({ number: 2, labels: [{ name: 'good-first-issue' }], assignees: [] }),
        makeIssue({ number: 3, labels: [{ name: 'good-first-issue' }], assignees: [{ login: 'alice' }] }),
      ]),
    );

    await watcher.poll();
    expect(dispatchTask).toHaveBeenCalledTimes(1);
    expect(dispatchTask).toHaveBeenCalledWith(expect.stringContaining('#3'));
  });

  it('skips dispatch when consent is denied', async () => {
    const deniedConsent = jest.fn().mockResolvedValue('denied');
    const { watcher, dispatchTask, fetchFn } = makeWatcher({ requestConsent: deniedConsent });
    fetchFn.mockResolvedValue(okResponse([makeIssue({ number: 9 })]));

    await watcher.poll();
    expect(deniedConsent).toHaveBeenCalledWith(expect.stringContaining('#9'));
    expect(dispatchTask).not.toHaveBeenCalled();
  });

  it('auto-grants when consentRequired is false', async () => {
    const { watcher, dispatchTask, requestConsent, fetchFn } = makeWatcher({ consentRequired: false });
    fetchFn.mockResolvedValue(okResponse([makeIssue({ number: 5 })]));

    await watcher.poll();
    expect(requestConsent).not.toHaveBeenCalled();
    expect(dispatchTask).toHaveBeenCalledTimes(1);
  });

  it('posts the completed summary back as a comment and survives restarts via state', async () => {
    const { watcher, fetchFn, stateFile } = makeWatcher();
    fetchFn.mockResolvedValue(okResponse([makeIssue({ number: 3 })]));

    await watcher.poll();
    await watcher.postResult('task-1', 'All tests green — fix landed');

    const commentCall = fetchFn.mock.calls.find(c => String(c[0]).includes('/issues/3/comments'));
    expect(commentCall).toBeTruthy();
    const [, init] = commentCall!;
    expect((init as RequestInit).method).toBe('POST');
    expect(JSON.parse(String((init as RequestInit).body)).body).toContain('fix landed');
    expect(fs.existsSync(stateFile)).toBe(true);

    // A fresh watcher over the same state file must not re-dispatch.
    const dispatchTask2 = jest.fn();
    const watcher2 = new IssueWatcher({
      repositories: [{ owner: 'acme', repo: 'app' }],
      stateFile,
      token: () => 'ghp_test',
      requestConsent: async () => 'granted',
      dispatchTask: dispatchTask2,
      fetch: fetchFn,
    });
    await watcher2.poll();
    expect(dispatchTask2).not.toHaveBeenCalled();
  });
});
