import { KnowledgeGraph } from '../../knowledge/KnowledgeGraph';
import { LLMConnector, LLMMessage } from './LLMConnector';
import { VectorMemory } from '../memory/VectorMemory';
import { getLogger } from '../Logger';
import { normalizePlanSteps } from './planDag';
import { createHash } from 'crypto';

export interface PlannedStep {
  /** Stable id other steps can reference in dependsOn (defaults to `step-<n>`). */
  id?: string;
  description: string;
  action: string;
  params: Record<string, unknown>;
  requiresKnowledge: string[];
  /** Ids of steps that must finish first; absent = may run in parallel. */
  dependsOn?: string[];
}

/** Every action the agent runtime can execute — the planner may only emit these. */
export const PLANNER_ACTIONS: readonly string[] = [
  'navigate', 'click', 'type', 'scroll', 'extract', 'wait',
  'file_read', 'file_write', 'search', 'think', 'web_search',
  'video_tool', 'video_produce',
  'open_app', 'open_chrome', 'app_click', 'app_type', 'app_key', 'app_hotkey', 'app_scroll', 'read_screen', 'chrome_evaluate',
  'repo_status', 'repo_list', 'repo_read', 'repo_write', 'repo_run', 'repo_open',
  'skill', 'skill_learn', 'delegate', 'mcp_call',
  'sm_devices', 'sm_on', 'sm_off', 'sm_schedule',
];

export interface TaskPlan {
  taskId: string;
  description: string;
  steps: PlannedStep[];
  confidence: number;
  needsClarification: boolean;
  clarificationQuestion?: string;
  estimatedTimeMs: number;
  /** SHA-256 hash of description + context for idempotent task creation. */
  idempotencyKey?: string;
}

export class TaskPlanner {
  private knowledge: KnowledgeGraph;
  private llm: LLMConnector;
  private memory?: VectorMemory;

  constructor(knowledge: KnowledgeGraph, llm: LLMConnector, memory?: VectorMemory) {
    this.knowledge = knowledge;
    this.llm = llm;
    this.memory = memory;
  }

  /** Generate SHA-256 idempotency key from task description and optional context. */
  static generateIdempotencyKey(description: string, context?: string): string {
    const payload = JSON.stringify({ description, context });
    return createHash('sha256').update(payload).digest('hex');
  }

  /** Attach persistent session memory so the planner recalls past tasks. */
  setMemory(memory: VectorMemory): void {
    this.memory = memory;
  }

  async planTask(taskId: string, description: string, context?: string): Promise<TaskPlan> {
    getLogger().info({ taskId, description }, 'Planning task');

    const relevantKnowledge = await this.searchRelevantKnowledge(description);
    const memoryContext = await this.recallMemory(description);

    const knowledgeContext = relevantKnowledge.map(n =>
      `[${n.id}] ${n.title}\n${n.content.substring(0, 1000)}`
    ).join('\n\n');

    const systemPrompt = `You are the task planner for Umbra OS, an AI computer assistant.
Your job is to break down a user request into a sequence of executable steps.

You have access to this knowledge base:
${knowledgeContext}

Persistent memory (past sessions the user already worked on):
${memoryContext || '(none yet)'}

Rules:
1. Break complex tasks into simple, atomic steps
2. Each step must be a single action
3. If the request is ambiguous (< 85% confidence), ask for clarification
4. Reference knowledge node IDs in your steps
5. Estimate time per step in milliseconds
6. To answer questions about current facts (news, elections, prices, people), use web_search with a short query; "search" only searches the local knowledge graph and cannot answer fresh questions
7. To make/produce/edit a video: use video_produce with params {description, title?, style?, voiceProfile?}; to run a single production tool (narration, stitching, subtitles, analysis, stock footage), use video_tool with params {tool, inputs}. video_tool calls the OpenMontage tool registry — the same tools a production studio uses.
8. video_produce renders a narrated video with a Remotion composition to ~/.umbra/videos/<slug>/final.mp4 and returns its path.
9. REAL DESKTOP MODE (Windows apps and your real browser with logins): when the task needs a desktop app (Notepad, Calculator, Word, Excel, Settings, File Explorer, any installed program), or the real Chrome with the user's logged-in profile, use:
   - open_app {app, args?} — launch any Windows app on Desktop 2 (a separate Windows virtual desktop; the user keeps using their desktop meanwhile)
   - open_chrome {url?} — open the real Chrome (user profile) on Desktop 2
   - app_click {x, y} — native click in the Desktop 2 app window (pixels from top-left of the window, window moved to 0,0 so window coords = screen coords)
   - app_type {text} — type text into the focused app
   - app_key {key} — key names: Enter, Tab, Escape, Backspace, Delete, Home, End, PageUp, PageDown, ArrowUp, ArrowDown, ArrowLeft, ArrowRight, Space, F1-F12, A-Z, 0-9
   - app_hotkey {modifiers: [ctrl|alt|shift|meta], key} — shortcuts like Ctrl+S, Alt+F4
   - app_scroll {deltaX, deltaY} — scroll the app window
   - read_screen — read the current text on the Desktop 2 screen (OCR of the app window, or the Chrome DOM)
   - chrome_evaluate {expression} — run JavaScript inside the real Chrome page (only after open_chrome)
   These actions control the REAL desktop with real mouse/keyboard, not a browser sandbox. For pure web tasks with no logins needed, navigate/click/type/extract are still preferred.
10. When a step fails, plan a recovery step (e.g. read_screen to observe, then app_key Escape, or open_app again).
11. TOOL CONNECTORS (MCP catalog — external services like Slack, Stripe, GitHub, Google Drive):
    - mcp_call {connector, tool?, input} — invoke a registered connector tool. connector is the catalog id (e.g. communication-slack), tool defaults to "invoke", input is the argument object. Use when the user names a specific service ("post to slack", "send invoice", "search drive") or when a step needs live data from an external service.
    - skill {intent?, tool?, input?} — run a skill from the 190+ skill stack (routing by intent).
    - skill_learn {skill, result, note?} — record a successful/error skill invocation for the recorder.
    - delegate {prompt, provider?, model?, maxTurns?} — hand a self-contained sub-task (deep research, a big coding task, document analysis) to the built-in dedicated reasoning engine (a separate agent process), and wait for its final answer. Use for tasks that are better done by a dedicated agent: "deep-dive this paper", "write this full module", "audit this codebase". Keep the prompt self-contained.
12. YOUR CODE REPOS (registered projects on this machine — the user's own projects): the agent can read, edit, run commands in and open any registered repo:
    - repo_status {repo?} — git status of one repo, or all registered repos if repo omitted (branch, last commit, dirty files). Run this FIRST when a task mentions one of the user's projects.
    - repo_list {repo, path?} — list files in the repo
    - repo_read {repo, path} — read a file from the repo
    - repo_write {repo, path, content} — write/edit a file in the repo (content is the full new file content)
    - repo_run {repo, command} — run any shell command in the repo folder (npm run build, npm test, git add/commit, python scripts, etc.). Use npm run build / npm test to verify changes!
    - repo_open {repo} — open the repo folder in VS Code on Desktop 2 (the second Windows virtual desktop, so it doesn't disturb the user)
    "repo" is the repo name (e.g. umbra, umbra ui desktop app, agent research, video building) or a path inside it.
12. To change code in a repo: repo_read the relevant file, repo_write the edited file, then repo_run a build/test command to verify. Never write code without verifying with repo_run.
13. PARALLEL EXECUTION: a step with no dependsOn may run at the same time as other such steps. For research/aggregation tasks (compare facts, gather several sources, look up multiple things and summarize), emit the independent gather steps FIRST with no dependsOn, then ONE aggregation step whose dependsOn lists every gather step's id. Give every step a stable id ("step-1", "step-2", ...) and only set dependsOn where an earlier step's result is genuinely needed.
14. SMART HOME (any connected platform — SmartThings, Home Assistant, Hubitat, openHAB, Tuya/Smart Life, Hive, Homey, Apple Home, Alexa, Google Home — lights, plugs, switches, thermostats, locks, sensors when the user asks to control their home/devices/lights):
    - sm_devices {} — list all devices across every connected smart home platform, with their on/off state and platform label. Run this FIRST when a task mentions devices by name you haven't seen, so you can match names.
    - sm_on {device} / sm_off {device} — turn a device on/off. "device" is the device name as shown on any connected platform (e.g. "Desk Lamp", "Porch Light") — matching is fuzzy across ALL platforms at once. Resolve the exact name from sm_devices output when unsure.
    - sm_schedule {device, command, kind, everyMinutes?, at?} — recurring device control (cron-style). kind "at" runs daily at HH:MM (24h, e.g. "19:00"); kind "everyMinutes" runs on an interval. Example: turn the porch light on every day at 7pm → sm_schedule {device: "Porch Light", command: "on", kind: "at", at: "19:00"}. Cancel or inspect schedules via sm_devices + user confirmation.
    Only use these when the user means their real smart home; otherwise ignore.

Respond with a JSON object:
{
  "confidence": <0-100>,
  "needsClarification": <true/false>,
  "clarificationQuestion": "<question if confidence < 85>",
  "steps": [
    {
      "id": "step-1",
      "description": "Step description",
      "action": "navigate|click|type|scroll|extract|wait|file_read|file_write|search|think|web_search|video_tool|video_produce|open_app|open_chrome|app_click|app_type|app_key|app_hotkey|app_scroll|read_screen|chrome_evaluate|repo_status|repo_list|repo_read|repo_write|repo_run|repo_open|skill|skill_learn|delegate|mcp_call|sm_devices|sm_on|sm_off|sm_schedule",
      "params": { ... },
      "requiresKnowledge": ["node-id"],
      "dependsOn": ["step-1"]
    }
  ],
  "estimatedTimeMs": <total ms>
}`;

    const messages: LLMMessage[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `Task: ${description}${context ? `\nContext: ${context}` : ''}` },
    ];

    const result = await this.llm.complete(messages, 'reasoning', { temperature: 0.2 });

    try {
      const parsed = JSON.parse(this.extractJSON(result.content));
      return {
        taskId,
        description,
        steps: normalizePlanSteps(parsed.steps || []),
        confidence: parsed.confidence || 50,
        needsClarification: parsed.needsClarification || false,
        clarificationQuestion: parsed.clarificationQuestion,
        estimatedTimeMs: parsed.estimatedTimeMs || 30000,
        idempotencyKey: TaskPlanner.generateIdempotencyKey(description, context),
      };
    } catch {
      return {
        taskId,
        description,
        steps: [{ description: 'Execute task', action: 'think', params: { instruction: description }, requiresKnowledge: [] }],
        confidence: 30,
        needsClarification: true,
        clarificationQuestion: `I couldn't plan "${description}" precisely. Can you provide more detail?`,
        estimatedTimeMs: 10000,
        idempotencyKey: TaskPlanner.generateIdempotencyKey(description, context),
      };
    }
  }

  async refinePlan(plan: TaskPlan, userFeedback: string): Promise<TaskPlan> {
    getLogger().info({ taskId: plan.taskId }, 'Refining plan with user feedback');

    const messages: LLMMessage[] = [
      { role: 'system', content: 'Refine the task plan based on user feedback. Return the same JSON format.' },
      { role: 'user', content: `Original task: ${plan.description}\nOriginal plan: ${JSON.stringify(plan.steps)}\nFeedback: ${userFeedback}` },
    ];

    const result = await this.llm.complete(messages, 'reasoning', { temperature: 0.3 });
    try {
      const refined = JSON.parse(this.extractJSON(result.content));
      return { 
        ...plan, 
        steps: refined.steps || plan.steps, 
        confidence: refined.confidence || plan.confidence,
        idempotencyKey: plan.idempotencyKey || TaskPlanner.generateIdempotencyKey(plan.description),
      };
    } catch {
      return plan;
    }
  }

  /** Pull user facts + recent/similar past tasks into the planning context. */
  private async recallMemory(description: string): Promise<string> {
    if (!this.memory) return '';
    try {
      const facts = this.memory.getFacts(20);
      const similar = await this.memory.searchSimilar(description, { k: 5, kind: 'task' });
      const recent = this.memory.getRecentActivity(5);
      const parts: string[] = [];
      if (facts.length > 0) {
        parts.push('About the user:\n' + facts.map(f => `- ${f.text}`).join('\n'));
      }
      if (similar.length > 0) {
        parts.push('Similar past tasks:\n' + similar.map(s => `- ${s.text.slice(0, 300)}`).join('\n'));
      }
      if (recent.length > 0) {
        parts.push('Recent tasks:\n' + recent.map(r => `- ${r.description} (${r.status})`).join('\n'));
      }
      return parts.join('\n\n');
    } catch {
      return '';
    }
  }

  private async searchRelevantKnowledge(description: string): Promise<any[]> {
    const results = await this.knowledge.search(description);
    const linkedNodes: any[] = [];

    for (const node of results.slice(0, 5)) {
      linkedNodes.push(node);
      const linked = await this.knowledge.getLinked(node.id);
      linkedNodes.push(...linked.slice(0, 3));
    }

    const unique = new Map<string, any>();
    for (const node of linkedNodes) {
      if (!unique.has(node.id)) unique.set(node.id, node);
    }

    return Array.from(unique.values()).slice(0, 10);
  }

  private extractJSON(text: string): string {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    return jsonMatch ? jsonMatch[0] : text;
  }
}
