/**
 * Umbra OS — agent sub-router (extracted from ApiServer route map).
 * Owns task lifecycle, chat dispatch, delegated agents, journal/skills,
 * durable task-queue handoff, repos and shutdown.
 * Re-exported via ApiServer — routes remain identical, only the definition
 * site moved. See `src/api/ApiServer.ts` for composition order.
 */
import type { ApiServerDeps } from '../ApiServer';
import { AppError } from '../AppError';

type Handler = (url: URL, body: Record<string, unknown>, match?: RegExpMatchArray) => Promise<unknown>;
export type AgentRouteEntry = [RegExp, Handler];

/**
 * An optional dependency is absent on this node. That is a capability gap, not
 * an internal fault — 501 Not Implemented tells the client "not supported
 * here" instead of "the server broke", which is what a bare 500 implied.
 */
function missing(dep: string): AppError {
  return new AppError(`${dep} is not available on this node`, 501);
}

export function agentRoutes(deps: ApiServerDeps): AgentRouteEntry[] {
  return [
    [/^GET \/api\/health$/, async () => ({ ok: true, uptimeMs: process.uptime() * 1000 })],
    [/^GET \/api\/status$/, async () => deps.getStatus()],
    [/^GET \/api\/tasks$/, async () => ({ tasks: deps.getActiveTasks() })],
    [/^GET \/api\/task\/([\w-]+)$/, async (_url, _body, match) => {
      const task = deps.getTask(match![1]);
      if (!task) throw new Error('Task not found');
      return { task };
    }],
    [/^GET \/api\/task\/([\w-]+)\/activity$/, async (_url, _body, match) => {
      const taskId = match![1];
      const activity = deps.getTaskActivity ? await deps.getTaskActivity(taskId) : [];
      return { activity };
    }],
    [/^POST \/api\/task$/, async (_url, body) => {
      const description = String(body.description || '').trim();
      if (!description) throw new Error('description is required');
      const priority = Number(body.priority || 0);
      const idempotencyKey = body.idempotencyKey ? String(body.idempotencyKey) : undefined;
      const taskId = await deps.submitTask(description, priority, idempotencyKey);
      return { taskId };
    }],
    [/^POST \/api\/task\/([\w-]+)\/cancel$/, async (_url, _body, match) => {
      if (!deps.cancelTask) throw missing('cancelTask');
      const taskId = match![1];
      await deps.cancelTask(taskId);
      return { cancelled: taskId };
    }],
    [/^POST \/api\/task\/([\w-]+)\/retry$/, async (_url, body, match) => {
      if (!deps.retryTask) throw missing('retryTask');
      const taskId = match![1];
      const description = body.description !== undefined ? String(body.description) : undefined;
      const retried = await deps.retryTask(taskId, description);
      return { taskId: retried && typeof retried === 'object' && 'id' in retried ? String((retried as { id: string }).id) : taskId };
    }],
    [/^POST \/api\/worker\/claim$/, async (_url, body) => {
      if (!deps.workerClaim) throw missing('workerClaim');
      const taskId = String(body.taskId || '');
      const workerId = String(body.workerId || '');
      if (!taskId || !workerId) throw new Error('taskId and workerId required');
      return { task: await deps.workerClaim(taskId, workerId) };
    }],
    [/^POST \/api\/worker\/heartbeat$/, async (_url, body) => {
      if (!deps.workerHeartbeat) throw missing('workerHeartbeat');
      const taskId = String(body.taskId || '');
      const workerId = String(body.workerId || '');
      if (!taskId || !workerId) throw new Error('taskId and workerId required');
      return { ok: await deps.workerHeartbeat(taskId, workerId) };
    }],
    [/^POST \/api\/worker\/release$/, async (_url, body) => {
      if (!deps.workerRelease) throw missing('workerRelease');
      const taskId = String(body.taskId || '');
      const workerId = String(body.workerId || '');
      if (!taskId || !workerId) throw new Error('taskId and workerId required');
      await deps.workerRelease(taskId, workerId);
      return { ok: true };
    }],
    [/^POST \/api\/worker\/recover$/, async (_url, body) => {
      if (!deps.workerRecover) throw missing('workerRecover');
      const workerId = String(body.workerId || '');
      if (!workerId) throw new Error('workerId required');
      return { reclaimed: await deps.workerRecover(workerId) };
    }],
    // Action proposal review flow
    [/^POST \/api\/actions\/propose$/, async (_url, body) => {
      if (!deps.proposeAction) throw missing('proposeAction');
      const taskId = String(body.taskId || '');
      const action = String(body.action || '');
      const args = (body.args && typeof body.args === 'object') ? body.args as Record<string, unknown> : {};
      if (!taskId || !action) throw new Error('taskId and action required');
      const idempotencyKey = body.idempotencyKey !== undefined ? String(body.idempotencyKey) : undefined;
      return { proposal: await deps.proposeAction(taskId, action, args, idempotencyKey) };
    }],
    [/^POST \/api\/actions\/review$/, async (_url, body) => {
      if (!deps.reviewAction) throw missing('reviewAction');
      const proposalId = String(body.proposalId || '');
      const approved = Boolean(body.approved);
      const hash = String(body.hash || '');
      if (!proposalId || !hash) throw new Error('proposalId and hash required');
      return { result: await deps.reviewAction(proposalId, approved, hash) };
    }],
    [/^GET \/api\/actions\/proposal\/([\w-]+)$/, async (_url, _body, match) => {
      if (!deps.getProposal) throw missing('getProposal');
      const proposalId = match![1];
      return { proposal: await deps.getProposal(proposalId) };
    }],
    [/^GET \/api\/task\/([\w-]+)\/proposals$/, async (_url, _body, match) => {
      if (!deps.listProposals) throw missing('listProposals');
      const taskId = match![1];
      return { proposals: await deps.listProposals(taskId) };
    }],
    // Input request for waiting_input pause/resume
    [/^POST \/api\/task\/([\w-]+)\/input$/, async (_url, body, match) => {
      if (!deps.requestInput) throw missing('requestInput');
      const taskId = match![1];
      const question = String(body.question || '');
      const options = Array.isArray(body.options) ? body.options.map(String) : undefined;
      if (!question) throw new Error('question required');
      return { inputRequest: await deps.requestInput(taskId, question, options) };
    }],
    [/^POST \/api\/input\/([\w-]+)\/answer$/, async (_url, body, match) => {
      if (!deps.submitInput) throw missing('submitInput');
      const inputId = match![1];
      const answer = String(body.answer || '');
      if (!answer) throw new Error('answer required');
      // taskId is in the body since inputId alone isn't enough to route
      const taskId = String(body.taskId || '');
      if (!taskId) throw new Error('taskId required');
      return { result: await deps.submitInput(taskId, inputId, answer) };
    }],
    [/^POST \/api\/chat$/, async (_url, body) => {
      const message = String(body.message || body.text || '').trim();
      if (!message) throw new Error('message is required');
      const target = body.target !== undefined ? String(body.target) : 'auto';
      return { dispatch: await deps.chat(message, target) };
    }],
    [/^POST \/api\/agent\/delegate$/, async (_url, body) => {
      const description = String(body.description || '');
      if (!description) throw new Error('description is required');
      const opts = {
        provider: body.provider !== undefined ? String(body.provider) : undefined,
        model: body.model !== undefined ? String(body.model) : undefined,
        timeoutMs: body.timeoutMs !== undefined ? Number(body.timeoutMs) : undefined,
      };
      return { output: await deps.delegateHermes(description, opts) };
    }],
    [/^POST \/api\/journal\/generate$/, async () => ({ journal: await deps.generateJournalNow() })],
    [/^POST \/api\/skills\/compile-hot$/, async (_url, body) => ({
      compiled: await deps.compileHotSkills(body.threshold !== undefined ? Number(body.threshold) : undefined),
    })],
    [/^GET \/api\/repos$/, async () => ({ repos: await deps.getRepos() })],
    [/^GET \/api\/task-queue\/export$/, async () => deps.exportTaskQueue()],
    [/^POST \/api\/task-queue\/import$/, async (_url, body) => ({
      sync: await deps.importTaskQueue({
        files: body.files && typeof body.files === 'object' ? body.files as Record<string, string> : undefined,
      }),
    })],
    [/^POST \/api\/shutdown$/, async () => {
      deps.shutdown();
      return { ok: true };
    }],
  ];
}

export default agentRoutes;
