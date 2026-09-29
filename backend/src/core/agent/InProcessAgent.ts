/**
 * InProcessAgent — a self-contained agentic reasoning loop that runs entirely
 * inside Umbra (no external CLI). It is the fallback for Hermes delegation:
 * when the `hermes` binary is not installed, delegated agentic tasks ("deep
 * research", "write this module", "audit this codebase") still work using the
 * app's own LLM provider + the same tool surface as the step loop.
 *
 * The loop is a bounded ReAct cycle: each turn the model emits either a JSON
 * tool call ({action, action_input}) or a final answer ({answer}). Tool
 * results are fed back as messages until the model answers or the turn/time
 * budget is exhausted.
 */

import { LLMMessage, LLMCompletionResult, LLMToolDeclaration, LLMToolCall } from './LLMConnector';
import { InjectionGuard } from './InjectionGuard';

export interface InProcessAgentTools {
  /** Call a catalog connector through the MCP router. */
  mcpCall?: (skill: string, tool: string, input: Record<string, unknown>) => Promise<{ ok: boolean; output: unknown; error?: string }>;
  /** Search the recall/knowledge graph. */
  searchKnowledge?: (query: string) => Promise<unknown>;
  /** Open a web search and return the page text. */
  webSearch?: (query: string) => Promise<string>;
  /** Execute a browser action on Desktop2 (navigate, click, type, extract, etc). */
  browserAction?: (action: string, params: Record<string, unknown>) => Promise<string>;
  /** Execute a real-desktop action (open_app, open_chrome, app_click, read_screen, etc). */
  desktopAction?: (action: string, params: Record<string, unknown>) => Promise<string>;
  /** Read a local file (sandboxed workspace). */
  fileRead?: (path: string) => Promise<string>;
  /** Write a local file (sandboxed workspace). */
  fileWrite?: (path: string, content: string) => Promise<{ bytes: number; path: string }>;
  /** Run a shell command in a repo. */
  repoRun?: (command: string, cwd?: string) => Promise<{ stdout: string; stderr: string; code: number }>;
  /** Execute a connector action (Gmail, Spotify, Stripe, etc). */
  connectorExecute?: (connectorId: string, endpoint: string, method: string, payload: Record<string, unknown>) => Promise<{ success: boolean; status: number; data: unknown; error?: string }>;
  /** Discover relevant connectors for a user query. */
  connectorDiscover?: (query: string, limit?: number) => Promise<Array<{ name: string; connectorId: string; description: string; authType: string }>>;
  /** Request user input mid-execution (pauses task). */
  askUser?: (question: string, options?: string[]) => Promise<{ paused: boolean; inputId: string }>;
}

export interface InProcessAgentOptions {
  llm: {
    complete(
      messages: LLMMessage[],
      role?: 'reasoning' | 'vision' | 'fast',
      options?: {
        model?: string;
        temperature?: number;
        maxTokens?: number;
        tools?: LLMToolDeclaration[];
        toolChoice?: 'auto' | 'none' | 'required';
      },
    ): Promise<LLMCompletionResult>;
  };
  tools?: InProcessAgentTools;
  /** Max model turns before giving up (default 8). */
  maxTurns?: number;
  /** Hard wall-clock timeout for the whole run (default 180s). */
  timeoutMs?: number;
  /** Optional model override for the reasoning calls. */
  model?: string;
  /**
   * Native tool-calling mode (dual-mode execution). When set, declarations
   * ride along on every completion call and `tool_calls` in the response are
   * executed through `execute`. Providers/models without native support
   * ignore the declarations and fall back to the JSON contract below —
   * both paths coexist in the same loop.
   */
  nativeTools?: NativeToolSpec;
  /**
   * Injection guard for untrusted tool results (webSearch page text, MCP
   * outputs). When set, results are scrubbed before they become LLM messages
   * and hits are recorded (optionally into the audit vault).
   */
  injectionGuard?: InjectionGuard;
}

/** Native function-calling surface (dual-mode execution). */
export interface NativeToolSpec {
  /** Build the tool declarations for this run (JIT retrieval per prompt). */
  getDeclarations(prompt: string): Promise<LLMToolDeclaration[]>;
  /** Execute one parsed tool call; returns the text fed back to the LLM. */
  execute: (call: LLMToolCall) => Promise<string>;
}

export interface InProcessAgentResult {
  ok: boolean;
  output: string;
  turns: number;
  durationMs: number;
  timedOut?: boolean;
  error?: string;
}

const DEFAULT_MAX_TURNS = 15;
const DEFAULT_TIMEOUT_MS = 180_000;

/** Robustly pull a JSON object out of an LLM reply (handles fenced blocks). */
export function extractJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  let candidate = trimmed;
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) candidate = fence[1].trim();
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    const parsed = JSON.parse(candidate.slice(start, end + 1));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function buildSystemPrompt(tools: InProcessAgentTools): string {
  const names = Object.entries(tools)
    .filter(([, fn]) => typeof fn === 'function')
    .map(([key]) => key);
  const toolDocs: Record<string, string> = {
    mcpCall: 'mcpCall: call a connected external tool/connector. Input: {skill, tool, input}',
    searchKnowledge: 'searchKnowledge: search Umbra\'s memory/knowledge graph. Input: {query}',
    webSearch: 'webSearch: search the web and return the top page text. Input: {query}',
    browserAction: 'browserAction: control the browser on Desktop2. Input: {action, params} where action is navigate|click|type|extract|wait|snapshot|evaluate|scroll|pressKey|hotkey|newTab|... and params is the action payload',
    desktopAction: 'desktopAction: control real Windows apps on Desktop2. Input: {action, params} where action is open_app|open_chrome|app_click|app_type|app_key|app_hotkey|app_scroll|read_screen|chrome_evaluate|get_info|wait and params is the payload',
    fileRead: 'fileRead: read a local file. Input: {path}',
    fileWrite: 'fileWrite: write a local file. Input: {path, content}',
    repoRun: 'repoRun: run a shell command inside the workspace. Input: {command, cwd?}',
    connectorDiscover: 'connectorDiscover: find available connectors for a task. Input: {query, limit?} — returns matching connectors with their IDs. Use this FIRST to find the right connector before executing.',
    connectorExecute: 'connectorExecute: execute an API call on a connected service (Gmail, Spotify, Stripe, Discord, etc). Input: {connectorId, endpoint, method, payload} — method is GET|POST|PUT|DELETE. The connectorId comes from connectorDiscover or from the catalog (e.g. "gmail", "spotify", "stripe").',
    askUser: 'askUser: pause execution and ask the user a question. Input: {question, options?} — returns {paused: true, inputId} when the task is paused waiting for user response. Use when you need clarification or approval mid-task.',
  };
  const available = names.map(n => toolDocs[n] ?? `${n}: available tool`).join('\n');
  return `You are Umbra, an autonomous agent. Complete the user's task by choosing actions yourself.

AVAILABLE TOOLS:
${available || '(none — answer directly)'}

RULES:
- Work toward a complete, correct result. Prefer acting over guessing.
- Keep tool inputs compact; if a tool result is long, summarize the relevant part.
- When you are done, reply with ONLY a JSON object: {"answer": "your final answer"}.
- For every action, reply with ONLY a JSON object: {"action": "toolName", "action_input": { ... }}.
- Do NOT use markdown fences around the JSON. No prose outside the JSON.`;
}

function truncate(text: string, max = 2000): string {
  return text.length > max ? `${text.slice(0, max)}\n…[truncated ${text.length - max} chars]` : text;
}

export class InProcessAgent {
  private options: InProcessAgentOptions;
  private maxTurns: number;
  private timeoutMs: number;

  constructor(options: InProcessAgentOptions) {
    this.options = options;
    this.maxTurns = options.maxTurns ?? DEFAULT_MAX_TURNS;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async run(prompt: string): Promise<InProcessAgentResult> {
    const started = Date.now();
    const tools = this.options.tools ?? {};
    const messages: LLMMessage[] = [
      { role: 'system', content: buildSystemPrompt(tools) },
      { role: 'user', content: prompt },
    ];

    // JIT tool retrieval for native function calling (per prompt).
    let nativeDecls: LLMToolDeclaration[] | undefined;
    if (this.options.nativeTools) {
      try {
        const decls = await this.options.nativeTools.getDeclarations(prompt);
        nativeDecls = decls.length > 0 ? decls : undefined;
      } catch {
        nativeDecls = undefined; // retrieval failure → JSON-contract mode
      }
    }

    const deadline = Date.now() + this.timeoutMs;
    let turns = 0;

    for (; turns < this.maxTurns; turns++) {
      if (Date.now() > deadline) {
        return { ok: false, output: '', turns, durationMs: Date.now() - started, timedOut: true, error: `Agent loop timed out after ${Math.round(this.timeoutMs / 1000)}s` };
      }

      const res = await this.options.llm.complete(messages, 'reasoning', {
        model: this.options.model,
        temperature: 0.2,
        maxTokens: 1200,
        ...(nativeDecls
          ? { tools: nativeDecls, toolChoice: 'auto' as const }
          : {}),
      });
      const reply = res.content.trim();

      // ── Native tool-call path (providers with function calling) ──
      const nativeCall = res.toolCalls?.[0];
      if (nativeCall && nativeDecls && this.options.nativeTools) {
        let toolText: string;
        try {
          toolText = await this.options.nativeTools.execute(nativeCall);
        } catch (err: any) {
          toolText = `ERROR: ${err?.message || 'tool execution failed'}`;
        }
        // Tool results are untrusted — scrub before they reach the LLM.
        const scrubbedNative = this.options.injectionGuard
          ? this.options.injectionGuard.scrub(toolText, `tool:${nativeCall.name}`).text
          : toolText;
        messages.push({ role: 'assistant', content: reply || JSON.stringify({ tool_call: nativeCall.name }) });
        messages.push({
          role: 'user',
          content: `Tool result for ${nativeCall.name} (call ${nativeCall.id}):\n${truncate(scrubbedNative, 3000)}\n\nContinue: call another tool or give the final answer.`,
        });
        continue;
      }

      const parsed = extractJsonObject(reply);
      if (!parsed) {
        // Model didn't follow the JSON contract — treat the raw reply as the answer.
        return { ok: true, output: truncate(reply, 4000), turns: turns + 1, durationMs: Date.now() - started };
      }
      if (parsed.answer !== undefined) {
        return { ok: true, output: truncate(String(parsed.answer), 4000), turns: turns + 1, durationMs: Date.now() - started };
      }
      const action = String(parsed.action || '').trim();
      const input = (parsed.action_input && typeof parsed.action_input === 'object' ? parsed.action_input : {}) as Record<string, unknown>;
      if (!action) {
        return { ok: true, output: truncate(reply, 4000), turns: turns + 1, durationMs: Date.now() - started };
      }

      const toolResult = await runBuiltinTool(tools, action, input, deadline);
      // Tool results are untrusted (web page text, external MCP output) —
      // quarantine any prompt-injection content before it reaches the LLM.
      const scrubbed = this.options.injectionGuard
        ? this.options.injectionGuard.scrub(toolResult, `tool:${action}`).text
        : toolResult;
      messages.push({ role: 'assistant', content: reply });
      messages.push({
        role: 'user',
        content: `Tool result for ${action}:\n${truncate(scrubbed, 3000)}\n\nContinue: either call another tool or reply {"answer": "..."}.`,
      });
    }

    return { ok: false, output: '', turns, durationMs: Date.now() - started, error: `Agent loop exceeded ${this.maxTurns} turns — giving up` };
  }

  /** Back-compat dispatch for in-class callers. */
  private async runTool(tools: InProcessAgentTools, action: string, input: Record<string, unknown>, deadline: number): Promise<string> {
    return runBuiltinTool(tools, action, input, deadline);
  }
}

/**
 * Execute one built-in (non-connector) tool. Exported so the native
 * function-calling path can dispatch to the exact same implementations as
 * the JSON-contract loop — full tool parity between the two modes.
 */
export async function runBuiltinTool(tools: InProcessAgentTools, action: string, input: Record<string, unknown>, deadline: number): Promise<string> {
    if (Date.now() > deadline) return 'TIMED_OUT';
    try {
      switch (action) {
        case 'mcpCall': {
          if (!tools.mcpCall) return `Tool unavailable: ${action}`;
          const skill = String(input.skill || input.connector || '');
          const tool = String(input.tool || 'invoke');
          const callInput = (input.input && typeof input.input === 'object' ? input.input : {}) as Record<string, unknown>;
          if (!skill) return 'mcpCall requires action_input.skill';
          const r = await tools.mcpCall(skill, tool, callInput);
          return r.ok ? `OK: ${typeof r.output === 'string' ? r.output : JSON.stringify(r.output)}` : `ERROR: ${r.error || 'call failed'}`;
        }
        case 'searchKnowledge': {
          if (!tools.searchKnowledge) return `Tool unavailable: ${action}`;
          const q = String(input.query || '');
          if (!q) return 'searchKnowledge requires action_input.query';
          const r = await tools.searchKnowledge(q);
          return `OK: ${JSON.stringify(r)}`;
        }
        case 'webSearch': {
          if (!tools.webSearch) return `Tool unavailable: ${action}`;
          const q = String(input.query || '');
          if (!q) return 'webSearch requires action_input.query';
          return await tools.webSearch(q);
        }
        case 'fileRead': {
          if (!tools.fileRead) return `Tool unavailable: ${action}`;
          return await tools.fileRead(String(input.path || ''));
        }
        case 'fileWrite': {
          if (!tools.fileWrite) return `Tool unavailable: ${action}`;
          const r = await tools.fileWrite(String(input.path || ''), String(input.content ?? ''));
          return `OK: wrote ${r.bytes} bytes to ${r.path}`;
        }
        case 'browserAction': {
          if (!tools.browserAction) return `Tool unavailable: ${action}`;
          const act = String(input.action || '');
          const params = (input.params && typeof input.params === 'object' ? input.params : input) as Record<string, unknown>;
          if (!act) return 'browserAction requires action_input.action';
          // allow flat params: if caller passes {action:"navigate", url:"..."} treat url as params
          const p = params.action ? (params.params as Record<string, unknown> || {}) : params;
          const a = params.action ? String(params.action) : act;
          return await tools.browserAction(a, p);
        }
        case 'desktopAction': {
          if (!tools.desktopAction) return `Tool unavailable: ${action}`;
          const act = String(input.action || '');
          const params = (input.params && typeof input.params === 'object' ? input.params : input) as Record<string, unknown>;
          if (!act) return 'desktopAction requires action_input.action';
          const p = params.action ? (params.params as Record<string, unknown> || {}) : params;
          const a = params.action ? String(params.action) : act;
          return await tools.desktopAction(a, p);
        }
        case 'repoRun': {
          if (!tools.repoRun) return `Tool unavailable: ${action}`;
          const r = await tools.repoRun(String(input.command || ''), input.cwd !== undefined ? String(input.cwd) : undefined);
          const out = [r.stdout, r.stderr].filter(Boolean).join('\n');
          return `Exit ${r.code}${out ? `:\n${truncate(out, 1500)}` : ''}`;
        }
        case 'connectorDiscover': {
          if (!tools.connectorDiscover) return `Tool unavailable: ${action}`;
          const q = String(input.query || input.description || '');
          if (!q) return 'connectorDiscover requires action_input.query';
          const limit = input.limit !== undefined ? Number(input.limit) : 5;
          const results = await tools.connectorDiscover(q, limit);
          if (results.length === 0) return 'No matching connectors found. Try a different query.';
          return `OK: Found ${results.length} connector(s):\n${results.map(c => `- ${c.connectorId}: ${c.description} (auth: ${c.authType})`).join('\n')}`;
        }
        case 'connectorExecute': {
          if (!tools.connectorExecute) return `Tool unavailable: ${action}`;
          const connectorId = String(input.connectorId || '');
          const endpoint = String(input.endpoint || '/');
          const method = String(input.method || 'GET').toUpperCase();
          const payload = (input.payload && typeof input.payload === 'object' ? input.payload : {}) as Record<string, unknown>;
          if (!connectorId) return 'connectorExecute requires action_input.connectorId';
          const r = await tools.connectorExecute(connectorId, endpoint, method, payload);
          if (r.success) return `OK (${r.status}): ${typeof r.data === 'string' ? r.data : JSON.stringify(r.data).slice(0, 3000)}`;
          return `ERROR (${r.status}): ${r.error || 'execution failed'}`;
        }
        case 'askUser': {
          if (!tools.askUser) return `Tool unavailable: ${action}`;
          const question = String(input.question || '');
          const options = Array.isArray(input.options) ? input.options.map(String) : undefined;
          if (!question) return 'askUser requires action_input.question';
          const result = await tools.askUser(question, options);
          return JSON.stringify(result);
        }
        default:
          return `Unknown action: ${action}`;
      }
    } catch (err: any) {
      return `ERROR: ${err.message}`;
    }
  }
