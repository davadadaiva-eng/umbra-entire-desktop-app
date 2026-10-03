import { Task, TaskStep, TaskResult, PlanTier, ActivityEntry, ActionProposal, InputRequest, TaskStatus } from '../../types';
import { TaskStore } from './TaskStore';
import * as path from 'path';
import { LLMConnector, LLMMessage } from './LLMConnector';
import { TaskPlanner, PlannedStep } from './TaskPlanner';
import { WorkspaceFiles } from './WorkspaceFiles';
import { ReposManager } from './ReposManager';
import { launchApp } from '../../native/win32/InputNative';
import { AgentDesktop } from '../workspace/AgentDesktop';
import { BrowserUseBridge } from '../browseruse/BrowserUseBridge';
import { KnowledgeGraph } from '../../knowledge/KnowledgeGraph';
import { SwarmManager } from '../workspace/SwarmManager';
import { SelfHealingGuard } from '../selfheal/SelfHealingGuard';
import { VectorMemory } from '../memory/VectorMemory';
import { AuditVault } from '../vault/AuditVault';
import { ConsentGate } from './ConsentGate';
import { Desktop2Environment } from '../desktop2/Desktop2Environment';
import { RealDesktop2 } from '../desktop2/RealDesktop2';
import { OpenMontageBridge } from '../video/OpenMontageBridge';
import { VideoProducer, VideoBrief } from '../video/VideoProducer';
import { SkillRouter } from '../skill/SkillRouter';
import { SkillRecorder } from '../skill/SkillRecorder';
import { SkillContentIndex } from '../skill/SkillContentIndex';
import { McpRouter } from '../mcp/McpRouter';
import { MeteringService } from '../metering/MeteringService';
import { GraphifyContextEngine } from '../graphify/GraphifyContextEngine';
import { HermesAgentBridge } from './HermesAgent';
import { InProcessAgent, NativeToolSpec } from './InProcessAgent';
import { ToolDefinition, toolFunctionName } from '../mcp/ToolDefinition';
import { LLMToolDeclaration } from './LLMConnector';
import { SmartThingsService, type SwitchCommand } from '../smart/SmartThingsService';
import { SmartHomeScheduler } from '../smart/SmartHomeScheduler';
import type { SmartHomeHub } from '../smart/SmartHomePlatform';
import { fuzzyScore } from '../smart/SmartHomePlatform';
import { eventBus } from '../EventBus';
import { getLogger } from '../Logger';
import { InjectionGuard } from './InjectionGuard';
import { validatePlanDag, groupPlanWaves } from './planDag';
import { LostLeaseError, TaskLeaseManager } from './TaskLease';
import { runBuiltinTool } from './InProcessAgent';
export class AgentRuntime {
  private llm: LLMConnector;
  private planner: TaskPlanner;
  private knowledge: KnowledgeGraph;
  private swarm?: SwarmManager;
  private healer?: SelfHealingGuard;
  private memory?: VectorMemory;
  private vault?: AuditVault;
  private consent?: ConsentGate;
  private desktop2?: Desktop2Environment;
  private realDesktop?: RealDesktop2;
  private workspace?: WorkspaceFiles;
  private agentDesktop?: AgentDesktop;
  private bridge?: BrowserUseBridge;
  private openmontage?: OpenMontageBridge;
  private videoProducer?: VideoProducer;
  private repos?: ReposManager;
  private skillRouter?: SkillRouter;
  private skillRecorder?: SkillRecorder;
  private skillContent?: SkillContentIndex;
  private mcpRouter?: McpRouter;
  private metering?: MeteringService;
  private graphify?: GraphifyContextEngine;
  private hermes?: HermesAgentBridge;
  private agentConnectorBridge?: import('../agent/AgentConnectorBridge').AgentConnectorBridge;
  /** When true, whole tasks are silently routed through the dedicated reasoning engine. */
  private autoDelegate: boolean = false;
  /** In-process agentic loop — fallback when the hermes CLI is not installed. */
  private inProcess?: InProcessAgent;
  /** Smart Home (Samsung SmartThings) — device control for the agent. */
  private smartThings?: SmartThingsService;
  private smartScheduler?: SmartHomeScheduler;
  private smartHub?: SmartHomeHub;
  private activeTasks: Map<string, Task> = new Map();
  private maxSteps: number = 15;
  /** Cap on how many independent plan steps may execute in parallel. */
  private maxParallelSteps: number = 4;
  /** JIT connector-tool retrieval (see registerSubsystems). */
  private connectorToolRetrieval?: (prompt: string, k?: number) => Promise<ToolDefinition[]>;
  /** Per-run cache of native tool declarations (prompt → declarations). */
  private nativeToolCache: { prompt: string; decls: LLMToolDeclaration[]; defs: ToolDefinition[] } | null = null;
  /** Durable task queue — enables cross-restart (and cross-node) resume. */
  private store?: TaskStore;
  private nodeRole: 'desktop' | 'cloud' = 'desktop';
  /** Quarantines prompt-injection attempts in untrusted observations before they reach an LLM. */
  private injectionGuard = new InjectionGuard();
  /** Task leases: heartbeat/guard/checkpoint (OpenMuse worker.ts port). */
  private readonly leases = new TaskLeaseManager();

  constructor(
    llm: LLMConnector,
    knowledge: KnowledgeGraph,
    planner: TaskPlanner,
    workspace?: WorkspaceFiles,
  ) {
    this.llm = llm;
    this.knowledge = knowledge;
    this.planner = planner;
    this.workspace = workspace;
  }

  registerSubsystems(subsystems: {
    swarm?: SwarmManager;
    healer?: SelfHealingGuard;
    memory?: VectorMemory;
    vault?: AuditVault;
    consent?: ConsentGate;
    desktop2?: Desktop2Environment;
    realDesktop?: RealDesktop2;
    agentDesktop?: AgentDesktop;
    bridge?: BrowserUseBridge;
    openmontage?: OpenMontageBridge;
    videoProducer?: VideoProducer;
    repos?: ReposManager;
    skillRouter?: SkillRouter;
    skillRecorder?: SkillRecorder;
    skillContent?: SkillContentIndex;
    mcpRouter?: McpRouter;
    metering?: MeteringService;
    graphify?: GraphifyContextEngine;
    hermes?: HermesAgentBridge;
    agentConnectorBridge?: import('../agent/AgentConnectorBridge').AgentConnectorBridge;
    /** Route whole tasks through the built-in reasoning engine when available. */
    autoDelegate?: boolean;
    /** Durable task queue for cross-restart resume. */
    taskStore?: TaskStore;
    /** Which node is running ('desktop' = the user's PC, 'cloud' = headless box). */
    nodeRole?: 'desktop' | 'cloud';
    /** Injection guard override (e.g. wired to the audit vault) — defaults to a standalone guard. */
    injectionGuard?: InjectionGuard;
    /** Cap on concurrent plan steps in a parallel wave (default 4). */
    maxParallelSteps?: number;
    /**
     * JIT connector-tool retrieval for native function calling: given the
     * user prompt, returns the top-K relevant ToolDefinitions. When wired,
     * the built-in reasoning engine uses native tool calls on capable models
     * and falls back to the JSON contract automatically (dual-mode).
     */
    connectorToolRetrieval?: (prompt: string, k?: number) => Promise<ToolDefinition[]>;
  }): void {
    if (subsystems.connectorToolRetrieval) this.connectorToolRetrieval = subsystems.connectorToolRetrieval;
    if (subsystems.swarm) this.swarm = subsystems.swarm;
    if (subsystems.healer) this.healer = subsystems.healer;
    if (subsystems.memory) this.memory = subsystems.memory;
    if (subsystems.vault) this.vault = subsystems.vault;
    if (subsystems.consent) this.consent = subsystems.consent;
    if (subsystems.desktop2) this.desktop2 = subsystems.desktop2;
    if (subsystems.realDesktop) this.realDesktop = subsystems.realDesktop;
    if (subsystems.agentDesktop) this.agentDesktop = subsystems.agentDesktop;
    if (subsystems.bridge) this.bridge = subsystems.bridge;
    if (subsystems.openmontage) this.openmontage = subsystems.openmontage;
    if (subsystems.videoProducer) this.videoProducer = subsystems.videoProducer;
    if (subsystems.repos) this.repos = subsystems.repos;
    if (subsystems.skillRouter) this.skillRouter = subsystems.skillRouter;
    if (subsystems.skillRecorder) this.skillRecorder = subsystems.skillRecorder;
    if (subsystems.skillContent) this.skillContent = subsystems.skillContent;
    if (subsystems.mcpRouter) this.mcpRouter = subsystems.mcpRouter;
    if (subsystems.metering) this.metering = subsystems.metering;
    if (subsystems.graphify) this.graphify = subsystems.graphify;
    if (subsystems.hermes) this.hermes = subsystems.hermes;
    if (subsystems.agentConnectorBridge) this.agentConnectorBridge = subsystems.agentConnectorBridge;
    if (subsystems.autoDelegate !== undefined) this.autoDelegate = subsystems.autoDelegate;
    if (subsystems.taskStore) this.store = subsystems.taskStore;
    if (subsystems.nodeRole) this.nodeRole = subsystems.nodeRole;
    if (subsystems.injectionGuard) this.injectionGuard = subsystems.injectionGuard;
    if (subsystems.maxParallelSteps !== undefined) this.maxParallelSteps = subsystems.maxParallelSteps;
  }

  async submitTask(description: string, priority: number = 0, idempotencyKey?: string): Promise<Task> {
    // Generate idempotency key if not provided
    const key = idempotencyKey ?? TaskStore.generateIdempotencyKey(description);
    
    // Check for existing task with same idempotency key
    if (this.store) {
      const existing = this.store.getTaskByIdempotencyKey(key);
      if (existing) {
        getLogger().info({ taskId: existing.id, idempotencyKey: key }, 'Returning existing task (idempotent)');
        this.activeTasks.set(existing.id, existing);
        eventBus.emit('task:created', existing.id);
        return existing;
      }
    }

    const task: Task = {
      id: crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      description,
      status: 'pending',
      priority,
      createdAt: new Date(),
      resumeNode: this.nodeRole,
      version: 0,
      idempotencyKey: key,
    };

    this.activeTasks.set(task.id, task);
    this.persist(task);
    this.logActivity(task.id, 'Task created', task.description);
    eventBus.emit('task:created', task.id);
    getLogger().info({ taskId: task.id, description, idempotencyKey: key }, 'Task submitted');

    this.executeTask(task).catch(err => {
      getLogger().error({ taskId: task.id, err }, 'Task execution failed');
    });

    return task;
  }

  private async executeTask(task: Task): Promise<void> {
    let sessionHeld = false;
    // Lease/heartbeat: one owner per task; stale leases are resumed from checkpoint.
    let lease;
    try {
      lease = this.leases.acquire(task.id);
    } catch {
      getLogger().debug({ taskId: task.id }, 'Task already leased elsewhere — skipping');
      return;
    }
    lease.startHeartbeat(() => {
      getLogger().warn({ taskId: task.id }, 'Task lease lost — aborting step loop');
    });

    try {
      if (this.metering) {
        sessionHeld = this.metering.openSession();
        if (!sessionHeld) {
          const snap = this.metering.snapshot();
          task.status = 'failed';
          task.error = `Session limit reached (${snap.activeSessions}/${snap.sessionsLimit} concurrent) — queued tasks are gated by the ${this.metering.currentTier} plan`;
          eventBus.emit('task:failed', task.id, task.error);
          getLogger().warn({ taskId: task.id, error: task.error }, 'Task blocked by metering session limit');
          return;
        }
      }

      // ── Resume path: a previous node already planned (and possibly partially
      //    ran) this task. Continue from the checkpoint instead of re-planning.
      if (task.plan && task.plan.length > 0) {
        this.logActivity(task.id, 'Task resumed', `Resuming from step ${task.completedStepCount ?? 0}`);
        eventBus.emit('task:started', task.id);
        await this.runPlanSteps(task);
        return;
      }

      task.status = 'planning';
      task.startedAt = new Date();
      task.resumeNode = this.nodeRole;
      this.persist(task);
      this.logActivity(task.id, 'Planning started', 'Generating execution plan');
      eventBus.emit('task:started', task.id);

      if (!task.consentGranted && this.consent) {
        const result = await this.consent.request(`Execute task: ${task.description}`);
        if (result !== 'granted') {
          task.status = 'failed';
          task.error = 'Consent denied by user';
          this.logActivity(task.id, 'Consent denied', 'User denied permission to execute task', 'error');
          eventBus.emit('task:failed', task.id, task.error);
          getLogger().warn({ taskId: task.id }, 'Task blocked by consent gate');
          return;
        }
        task.consentGranted = true;
        this.persist(task);
        this.logActivity(task.id, 'Consent granted', 'User approved task execution', 'success');
      }

      if (await this.tryFastEngine(task)) return;

      // Silent whole-task delegation: when the dedicated reasoning engine is
      // available, hand the task to it and only fall back to the visible
      // step-by-step loop if it cannot handle the task.
      if (await this.tryAutoDelegate(task)) return;

      const plan = await this.planner.planTask(task.id, task.description);

      if (plan.needsClarification) {
        task.status = 'pending';
        this.persist(task);
        this.logActivity(task.id, 'Clarification needed', plan.clarificationQuestion ?? 'Task needs clarification', 'warning');
        getLogger().info({ taskId: task.id, question: plan.clarificationQuestion }, 'Task needs clarification');
        return;
      }

      task.plan = plan.steps;
      task.steps = [];
      task.completedStepCount = 0;
      task.status = 'executing';
      this.persist(task);
      this.logActivity(task.id, 'Execution started', `Plan has ${plan.steps.length} steps`, 'info');

      await this.runPlanSteps(task);

    } catch (err: any) {
      if (err instanceof LostLeaseError) {
        // Another worker took over (or heartbeat expired): requeue from the
        // last checkpoint so resume picks it up instead of failing it.
        task.status = 'pending';
        this.persist(task);
        getLogger().warn({ taskId: task.id }, 'Task lease lost — requeued from checkpoint');
        eventBus.emit('task:failed', task.id, err.message);
      } else {
        task.status = 'failed';
        task.error = err.message;
        this.logActivity(task.id, 'Task failed', err.message, 'error');
        getLogger().error({ taskId: task.id, err: err.message }, 'Task execution failed');
        eventBus.emit('task:failed', task.id, err.message);
      }
    } finally {
      lease.release();
      this.leases.release(task.id, lease.leaseId);
      if (sessionHeld) this.metering?.closeSession();
      // Persist the terminal state so the durable queue holds an accurate
      // record. Keep failed/cancelled tasks archived so retryTask can resume
      // the plan after a restart — only completed tasks leave the queue (they
      // live on in recall/memory).
      if (this.isTerminal(task)) {
        this.persist(task);
        if (task.status === 'completed') {
          this.logActivity(task.id, 'Task completed', task.result?.summary ?? 'Task completed successfully', 'success');
          this.store?.remove(task.id);
        } else if (task.status === 'failed') {
          this.logActivity(task.id, 'Task failed', task.error ?? 'Unknown error', 'error');
        } else if (task.status === 'cancelled') {
          this.logActivity(task.id, 'Task cancelled', task.error ?? 'Cancelled by user', 'warning');
        }
      }
    }
  }

  /** Run a task's plan steps, starting from the checkpoint (or 0). */
  private async runPlanSteps(task: Task): Promise<void> {
    const plan = task.plan!;
    const steps = task.steps ?? [];
    const start = task.completedStepCount ?? steps.length;
    task.status = 'executing';
    if (!task.startedAt) task.startedAt = new Date();
    this.persist(task);

    // Fresh plans run as a dependency DAG: independent steps execute in
    // parallel waves. Resumed plans (checkpointed mid-run) keep the
    // sequential loop — the durable checkpoint only records a contiguous
    // count, so partial-wave state cannot be reconstructed safely.
    if (start === 0 && (await this.runPlanWaves(task))) {
      return;
    }

    for (let i = start; i < plan.length; i++) {
      // Lease guard: abort when another worker owns the task now.
      this.leases.get(task.id)?.guard();
      if (steps.length >= this.maxSteps) {
        getLogger().warn({ taskId: task.id, maxSteps: this.maxSteps }, 'Task step budget exhausted');
        break;
      }

      if (this.consent && (await this.consent.checkEmergencyStop())) {
        task.status = 'cancelled';
        task.error = 'Emergency stop armed';
        this.logActivity(task.id, 'Emergency stop', 'Task cancelled via emergency stop', 'warning');
        eventBus.emit('task:cancelled', task.id);
        this.persist(task);
        return;
      }

      const step = await this.executeStep(task, plan[i], i);
      steps.push(step);
      // Checkpoint on step (lease-guarded + durable persist for resume on boot).
      const lease = this.leases.get(task.id);
      if (lease) lease.checkpoint(task, { completedStepCount: i + 1 } as Partial<Task>);
      else task.completedStepCount = i + 1;
      this.persist(task); // checkpoint after every step

      // Check if task is waiting for input — pause execution
      if ((task.status as TaskStatus) === 'waiting_input') {
        this.logActivity(task.id, 'Paused for input', 'Task paused waiting for user input', 'warning');
        return; // Exit runPlanSteps, will resume when input is submitted
      }

      if (step.error) {
        task.status = 'healing';
        this.persist(task);
        this.logActivity(task.id, 'Healing', `Step failed: ${step.error}. Attempting recovery...`, 'warning');
        const healed = await this.attemptHealing(task, plan[i]);
        if (!healed) {
          task.status = 'failed';
          task.error = step.error;
          this.logActivity(task.id, 'Healing failed', `Could not recover from: ${step.error}`, 'error');
          eventBus.emit('task:failed', task.id, step.error);
          return;
        }
        this.logActivity(task.id, 'Healing succeeded', 'Recovery successful, continuing execution', 'success');
        task.status = 'executing';
      }
    }

    const result: TaskResult = {
      summary: `Completed: ${task.description}`,
      output: null,
      steps,
      totalTimeMs: Date.now() - (task.startedAt?.getTime() ?? Date.now()),
    };

    task.status = 'completed';
    task.completedAt = new Date();
    task.result = result;
    this.persist(task);
    eventBus.emit('task:completed', task.id, result);

    await this.recordExecution(task, steps);
  }

  /**
   * Execute a fresh plan as a dependency DAG (wave dispatch): every wave
   * holds the steps whose dependencies all completed earlier, and the steps
   * in a wave run concurrently — capped by maxParallelSteps and the metering
   * tier's session limit (free = 1, so free plans stay sequential). Failed
   * steps heal before the next wave starts; an invalid DAG (missing
   * dependency / cycle) falls back to the sequential loop.
   *
   * @returns true when the plan was fully handled (finished, failed,
   *   cancelled, or budget-exhausted); false to run sequentially instead.
   */
  private async runPlanWaves(task: Task): Promise<boolean> {
    const plan = task.plan!;
    const steps = task.steps ?? [];
    const dagError = validatePlanDag(plan);
    if (dagError) {
      getLogger().warn({ taskId: task.id, error: dagError }, 'Plan DAG invalid — falling back to sequential execution');
      return false;
    }
    const parallel = Math.min(
      this.maxParallelSteps,
      this.metering?.limits.maxConcurrentSessions ?? this.maxParallelSteps,
    );
    const results: (TaskStep | undefined)[] = Array.from({ length: plan.length });
    let executedCount = 0;

    for (const wave of groupPlanWaves(plan)) {
      if (executedCount >= this.maxSteps) {
        getLogger().warn({ taskId: task.id, maxSteps: this.maxSteps }, 'Task step budget exhausted');
        break;
      }
      if (this.consent && (await this.consent.checkEmergencyStop())) {
        task.status = 'cancelled';
        task.error = 'Emergency stop armed';
        eventBus.emit('task:cancelled', task.id);
        this.persist(task);
        return true;
      }

      const runnable = wave.slice(0, this.maxSteps - executedCount);
      for (let i = 0; i < runnable.length; i += parallel) {
        const chunk = runnable.slice(i, i + parallel);
        const executed = await Promise.all(chunk.map(idx => this.executeStep(task, plan[idx], idx)));
        chunk.forEach((idx, k) => { results[idx] = executed[k]; });
        executedCount += chunk.length;
        // Keep task.steps in plan order + checkpoint after each chunk so the
        // durable queue holds a contiguous resume point.
        steps.length = 0;
        for (let j = 0; j < plan.length; j++) if (results[j]) steps.push(results[j]!);
        task.completedStepCount = executedCount;
        this.persist(task);

        // Check if task is waiting for input — pause execution
        if ((task.status as TaskStatus) === 'waiting_input') {
          this.logActivity(task.id, 'Paused for input', 'Task paused waiting for user input', 'warning');
          return true; // Exit runPlanWaves, will resume when input is submitted
        }
      }

      // Heal failed steps (plan order) before dependent waves start.
      for (const idx of runnable) {
        const step = results[idx];
        if (!step || !step.error) continue;
        task.status = 'healing';
        this.persist(task);
        const healed = await this.attemptHealing(task, plan[idx]);
        if (!healed) {
          task.status = 'failed';
          task.error = step.error;
          eventBus.emit('task:failed', task.id, step.error);
          return true;
        }
        task.status = 'executing';
      }
    }

    steps.length = 0;
    for (let j = 0; j < plan.length; j++) if (results[j]) steps.push(results[j]!);
    task.completedStepCount = plan.length;
    this.persist(task);

    const result: TaskResult = {
      summary: `Completed: ${task.description}`,
      output: null,
      steps,
      totalTimeMs: Date.now() - (task.startedAt?.getTime() ?? Date.now()),
    };
    task.status = 'completed';
    task.completedAt = new Date();
    task.result = result;
    this.persist(task);
    eventBus.emit('task:completed', task.id, result);
    await this.recordExecution(task, steps);
    return true;
  }

  private persist(task: Task): void {
    // Use CAS if task has a version (i.e., it's been loaded from store)
    if (this.store && task.version !== undefined && task.version > 0) {
      const updated = this.store.compareAndSwap(task.id, task.version, task);
      if (updated) {
        // Update local copy with new version
        task.version = updated.version;
        this.activeTasks.set(task.id, task);
      } else {
        // Concurrent modification - reload from store
        getLogger().warn({ taskId: task.id }, 'CAS failed — concurrent modification, reloading');
        const reloaded = this.store.loadAll().find(t => t.id === task.id);
        if (reloaded) {
          this.activeTasks.set(reloaded.id, reloaded);
          Object.assign(task, reloaded);
        }
      }
    } else {
      // First save - no version yet
      this.store?.save(task);
    }
  }

  private logActivity(taskId: string, title: string, detail: string, status: 'info' | 'success' | 'warning' | 'error' = 'info'): void {
    this.store?.logActivity(taskId, title, detail, status);
    eventBus.emit('task:activity', taskId, { title, detail, status, timestamp: new Date() });
  }

  private isTerminal(task: Task): boolean {
    return task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled';
  }

  /**
   * Reload unfinished tasks from the durable queue and resume them.
   *
   * Gating: the user's own PC (desktop role) always resumes its queue. A cloud
   * node only resumes when the plan is paid (pro/ultimate/byok) — cloud
   * continuation is not part of the free plan.
   *
   * @returns the number of tasks resumed.
   */
  async resumePendingTasks(nodeRole: 'desktop' | 'cloud', tier: PlanTier): Promise<number> {
    if (!this.store) return 0;
    const unfinished = this.store.loadUnfinished();
    let resumed = 0;

    for (const task of unfinished) {
      if (nodeRole === 'cloud' && tier === 'free') {
        getLogger().warn({ taskId: task.id }, 'Cloud resume skipped — free plan does not include cloud continuation');
        continue;
      }
      // Resume on boot: skip tasks leased elsewhere, resume stale checkpoints.
      if (!this.leases.recoverIfStale(task.id)) {
        getLogger().debug({ taskId: task.id }, 'Resume skipped — task leased by a live worker');
        continue;
      }
      task.resumeNode = nodeRole;
      this.activeTasks.set(task.id, task);
      eventBus.emit('task:created', task.id);
      this.executeTask(task).catch(err => {
        getLogger().error({ taskId: task.id, err }, 'Resumed task execution failed');
      });
      resumed++;
    }

    if (resumed > 0) {
      getLogger().info({ resumed, nodeRole, tier }, 'Resumed in-flight tasks from the durable queue');
    }
    return resumed;
  }

  private async executeStep(task: Task, plannedStep: PlannedStep, index: number): Promise<TaskStep> {
    const step: TaskStep = {
      description: plannedStep.description,
      action: plannedStep.action,
      params: plannedStep.params,
      startedAt: new Date(),
      completedAt: new Date(),
    };

    // Check if task is waiting for input — if so, pause execution
    if ((task.status as TaskStatus) === 'waiting_input') {
      const pending = this.store?.getPendingInputRequest(task.id);
      if (pending) {
        // Wait for input to be provided (polling with timeout)
        const startWait = Date.now();
        const maxWaitMs = 5 * 60 * 1000; // 5 minutes max wait
        while ((task.status as TaskStatus) === 'waiting_input' && Date.now() - startWait < maxWaitMs) {
          await new Promise(r => setTimeout(r, 1000));
          // Reload task to check status
          const reloaded = this.store?.loadAll().find(t => t.id === task.id);
          if (reloaded) {
            Object.assign(task, reloaded);
          }
        }
        // After wait, check if input was received
        if ((task.status as TaskStatus) === 'waiting_input') {
          step.error = 'Input request timed out';
          step.completedAt = new Date();
          return step;
        }
        // Input received, continue execution
      }
    }

    getLogger().info({ taskId: task.id, step: index, action: plannedStep.action }, 'Executing step');

    try {
      switch (plannedStep.action) {
        case 'think':
          step.result = await this.thinkStep(task.description, plannedStep.params);
          break;
        case 'navigate':
        case 'click':
        case 'type':
        case 'scroll':
        case 'extract':
          step.result = await this.executeDesktopStep(task, plannedStep);
          break;
        case 'open_app':
        case 'open_chrome':
        case 'app_click':
        case 'app_click_selector':
        case 'app_type':
        case 'app_key':
        case 'app_hotkey':
        case 'app_scroll':
        case 'read_screen':
        case 'chrome_evaluate':
          step.result = await this.executeRealDesktopStep(task, plannedStep);
          break;
        case 'web_search':
          step.result = await this.webSearchStep(plannedStep);
          break;
        case 'file_read':
          if (!this.workspace) throw new Error('Workspace not configured');
          step.result = await this.workspace.read(String(plannedStep.params?.path || ''));
          break;
        case 'file_write':
          if (!this.workspace) throw new Error('Workspace not configured');
          const written = await this.workspace.write(
            String(plannedStep.params?.path || ''),
            String(plannedStep.params?.content ?? ''),
          );
          step.result = `Wrote ${written.bytes} bytes to ${written.path}`;
          break;
        case 'search':
          const searchResults = await this.knowledge.search(String(plannedStep.params?.query || ''));
          step.result = JSON.stringify(searchResults.map(n => ({ id: n.id, title: n.title })));
          break;
        case 'repo_list':
          if (!this.repos) throw new Error('Repos not configured');
          step.result = JSON.stringify(
            await this.repos.list(
              String(plannedStep.params?.repo || ''),
              plannedStep.params?.path ? String(plannedStep.params.path) : '.',
            ),
          );
          break;
        case 'repo_read':
          if (!this.repos) throw new Error('Repos not configured');
          step.result = await this.repos.read(
            String(plannedStep.params?.repo || ''),
            String(plannedStep.params?.path || ''),
          );
          break;
        case 'repo_write':
          if (!this.repos) throw new Error('Repos not configured');
          const repoWrite = await this.repos.write(
            String(plannedStep.params?.repo || ''),
            String(plannedStep.params?.path || ''),
            String(plannedStep.params?.content ?? ''),
          );
          step.result = `Wrote ${repoWrite.bytes} bytes to ${repoWrite.path}`;
          break;
        case 'repo_run':
          if (!this.repos) throw new Error('Repos not configured');
          const runRes = await this.repos.run(
            String(plannedStep.params?.repo || ''),
            String(plannedStep.params?.command || ''),
            Number(plannedStep.params?.timeoutMs || 120000),
          );
          const runOut = [runRes.stdout, runRes.stderr].filter(Boolean).join('\n');
          step.result = runRes.timedOut
            ? `Command timed out (${String(plannedStep.params?.timeoutMs || 120000)}ms). Partial output:\n${runOut}`
            : `Exit code ${runRes.code}${runOut ? `\n${runOut}` : ''}`;
          break;
        case 'repo_status':
          if (!this.repos) throw new Error('Repos not configured');
          if (plannedStep.params?.repo) {
            step.result = JSON.stringify(await this.repos.gitStatus(String(plannedStep.params.repo)));
          } else {
            step.result = JSON.stringify(await this.repos.statusAll());
          }
          break;
        case 'repo_open':
          if (!this.repos) throw new Error('Repos not configured');
          const target = this.repos.resolveRepo(String(plannedStep.params?.repo || ''));
          const { command, args } = this.repos.openInEditor(target.name);
          if (this.realDesktop) {
            step.result = await this.realDesktop.openApp(command, [...args, '--new-window']);
          } else {
            if (!launchApp(command, args)) throw new Error(`Could not open editor for ${target.name}`);
            step.result = `Opened ${target.name} (${command})`;
          }
          break;
        case 'wait':
          const ms = Number(plannedStep.params?.ms || 1000);
          await new Promise(r => setTimeout(r, ms));
          step.result = `Waited ${ms}ms`;
          break;
        case 'skill':
          step.result = await this.executeSkillStep(task, plannedStep);
          break;
        case 'mcp_call':
          step.result = await this.executeMcpCallStep(plannedStep);
          break;
        case 'skill_learn':
          step.result = this.recordSkillInvocation(
            String(plannedStep.params?.skill ?? 'learned'),
            Date.now(),
            plannedStep.params?.result !== 'error',
            String(plannedStep.params?.note ?? 'recorded'),
          );
          break;
        case 'video_tool':
          if (!this.openmontage) throw new Error('OpenMontage bridge not configured');
          const toolName = String(plannedStep.params?.tool || '');
          if (!toolName) throw new Error('video_tool needs params.tool');
          const toolParams = (plannedStep.params?.inputs as Record<string, unknown>) || {};
          const toolRes = await this.openmontage.runTool(toolName, toolParams);
          step.result = toolRes.success
            ? JSON.stringify({ data: toolRes.data, artifacts: toolRes.artifacts, cost_usd: toolRes.cost_usd, duration_seconds: toolRes.duration_seconds })
            : `Tool ${toolName} failed: ${toolRes.error || 'unknown error'}`;
          break;
        case 'video_produce':
          if (!this.videoProducer) throw new Error('VideoProducer not configured');
          const brief: VideoBrief = {
            description: String(plannedStep.params?.description || plannedStep.params?.brief || task.description),
            title: plannedStep.params?.title ? String(plannedStep.params.title) : undefined,
            voiceProfile: plannedStep.params?.voiceProfile ? String(plannedStep.params.voiceProfile) : undefined,
            style: plannedStep.params?.style ? String(plannedStep.params.style) : undefined,
          };
          const produced = await this.videoProducer.produceVideo(brief);
          step.result = JSON.stringify({
            videoPath: produced.videoPath,
            narrationPath: produced.narrationPath,
            title: produced.script.title,
          });
          break;
        case 'delegate':
          if (!this.hermes) throw new Error('Dedicated reasoning engine not configured');
          step.result = await this.delegateToHermes(task, plannedStep);
          break;
        case 'sm_devices':
          step.result = await this.executeSmartDevicesStep();
          break;
        case 'sm_on':
        case 'sm_off':
          step.result = await this.executeSmartControlStep(
            plannedStep.action === 'sm_on' ? 'on' : 'off',
            String(plannedStep.params?.device || plannedStep.params?.name || ''),
          );
          break;
        case 'sm_schedule':
          step.result = await this.executeSmartScheduleStep(plannedStep.params || {});
          break;
        default:
          step.result = `Unknown action: ${plannedStep.action}`;
      }

      this.vault?.log('step_executed', plannedStep.action, plannedStep.params, step.result || 'ok');
    } catch (err: any) {
      step.error = err.message;
      this.vault?.log('step_failed', plannedStep.action, plannedStep.params, err.message);
    }

    step.completedAt = new Date();
    return step;
  }

  private async tryFastEngine(task: Task): Promise<boolean> {
    if (!this.bridge || !this.bridge.isReady()) return false;
    const engine = process.env['UMBRA_ENGINE'] || 'browseruse';
    if (engine !== 'browseruse') return false; // desktop2 / ghost modes use the real-desktop loop

    if (this.consent && (await this.consent.checkEmergencyStop())) {
      task.status = 'cancelled';
      task.error = 'Emergency stop armed';
      eventBus.emit('task:cancelled', task.id);
      return true;
    }

    try {
      await this.agentDesktop?.ensure();
    } catch (err: any) {
      getLogger().warn({ err: err.message }, 'Fast engine: agent desktop unavailable');
    }

    task.status = 'executing';
    const steps: TaskStep[] = [];
    const stopFile = path.join(process.env['USERPROFILE'] || '.', '.umbra', 'emergency-stop');

    const run = (model: 'fast' | 'reasoning') => this.bridge!.submit({
      task: task.description,
      stopFile,
      maxSteps: 25,
      model,
      onProgress: (info, n) => {
        if (!info) return;
        const s: TaskStep = {
          description: `Step ${n}: ${info}`,
          action: 'web_research',
          params: {},
          startedAt: new Date(),
          completedAt: new Date(),
          result: undefined,
        };
        steps.push(s);
        eventBus.emit('task:progress', task.id, n);
      },
    });

    let res = await run('fast');
    if (!res.ok && !res.aborted) {
      getLogger().warn({ err: res.error }, 'Fast engine failed with fast model — retrying with reasoning model');
      res = await run('reasoning');
    }

    if (res.aborted) {
      task.status = 'cancelled';
      task.error = 'Emergency stop armed';
      eventBus.emit('task:cancelled', task.id);
      return true;
    }

    if (res.ok && res.result) {
      const final: TaskStep = {
        description: `Researched via browser-use (${res.steps ?? '?'} steps in ${res.seconds ?? '?'}s${res.url ? `, last URL: ${res.url}` : ''})`,
        action: 'web_research',
        params: { task: task.description },
        startedAt: new Date(),
        completedAt: new Date(),
        result: res.result,
      };
      steps.push(final);

      const result: TaskResult = {
        summary: res.result,
        output: res.result,
        steps,
        totalTimeMs: Date.now() - task.startedAt!.getTime(),
      };
      task.status = 'completed';
      task.completedAt = new Date();
      task.result = result;
      eventBus.emit('task:completed', task.id, result);
      await this.recordExecution(task, steps);
      this.vault?.log('task_completed', task.description, { engine: 'browser-use', steps: res.steps, seconds: res.seconds }, res.result);
    } else {
      task.status = 'failed';
      task.error = res.error || 'Fast engine failed';
      eventBus.emit('task:failed', task.id, task.error);
    }
    return true;
  }

  /**
   * Silently route a whole task through the dedicated reasoning engine.
   * Returns true when the task was completed this way (or the failure is fatal);
   * returns false so the caller falls back to the visible step-by-step loop.
   */
  private async tryAutoDelegate(task: Task): Promise<boolean> {
    if (!this.autoDelegate) return false;
    const hermesReady = this.hermes?.isInstalled() === true;
    if (!hermesReady && !this.inProcessAgent()) {
      getLogger().debug('Auto-delegate skipped — no dedicated engine (CLI or in-process) available');
      return false;
    }
    // The in-process fallback only has web/knowledge/MCP/file tools, so in
    // ghost/desktop2 modes we keep the visible step loop (which can drive
    // real apps and the desktop). Explicit `delegate` steps and the API still
    // use the fallback everywhere.
    if (!hermesReady && (process.env['UMBRA_ENGINE'] || 'browseruse') !== 'browseruse' && this.realDesktop) {
      return false;
    }
    getLogger().info({ taskId: task.id, engine: hermesReady ? 'hermes' : 'in-process' }, 'Routing task through dedicated reasoning engine');
    try {
      const output = await this.delegateTask(task.description);
      const started = task.startedAt || new Date();
      const steps: TaskStep[] = [
        {
          description: `Completed: ${task.description}`,
          action: 'delegate',
          params: {},
          startedAt: started,
          completedAt: new Date(),
          result: output,
        },
      ];
      const result: TaskResult = {
        summary: output,
        output,
        steps,
        totalTimeMs: Date.now() - started.getTime(),
      };
      task.status = 'completed';
      task.completedAt = new Date();
      task.result = result;
      eventBus.emit('task:completed', task.id, result);
      await this.recordExecution(task, steps);
      this.vault?.log('task_completed', task.description, { engine: 'subagent' }, output);
      return true;
    } catch (err: any) {
      getLogger().warn({ taskId: task.id, err: err.message }, 'Dedicated engine unavailable — falling back to step-by-step execution');
      task.status = 'planning';
      return false;
    }
  }

  /**
   * Delegate a step (or the whole task) to the dedicated reasoning engine.
   * Prefers the hermes CLI; falls back to the in-process agent loop when the
   * CLI is not installed, so agentic delegation works on every node.
   */
  async delegateToHermes(task: Task, plannedStep?: PlannedStep): Promise<string> {
    const prompt = String(plannedStep?.params?.prompt || task.description);
    const provider = plannedStep?.params?.provider ? String(plannedStep.params.provider) : undefined;
    const model = plannedStep?.params?.model ? String(plannedStep.params.model) : undefined;
    const maxTurns = plannedStep?.params?.maxTurns ? Number(plannedStep.params.maxTurns) : undefined;

    if (this.hermes?.isInstalled()) {
      const res = await this.hermes.runTask(prompt, { provider, model, maxTurns });
      if (res.ok) {
        this.vault?.log('task_delegated', task.id, { engine: 'subagent', durationMs: res.durationMs }, res.output);
        return res.output;
      }
      throw new Error(`Agent task failed${res.error ? `: ${res.error}` : ''}`);
    }

    // Fallback: in-process agentic loop with the same tool surface.
    const agent = this.inProcessAgent();
    if (!agent) throw new Error('Dedicated reasoning engine not configured');
    const res = await agent.run(prompt);
    if (!res.ok) throw new Error(`Agent task failed${res.error ? `: ${res.error}` : ''}`);
    this.vault?.log('task_delegated', task.id, { engine: 'in-process', turns: res.turns, durationMs: res.durationMs }, res.output);
    return res.output;
  }

  /** Register the Smart Home subsystem (SmartThings device control for the agent). */
  registerSmartHome(svc: SmartThingsService, scheduler: SmartHomeScheduler): void {
    this.smartThings = svc;
    this.smartScheduler = scheduler;
    // Reset the cached in-process loop so the new tool surface is picked up.
    this.inProcess = undefined;
  }

  /** Register the multi-platform Smart Home hub (cross-platform device control). */
  registerSmartHomeHub(hub: SmartHomeHub): void {
    this.smartHub = hub;
    this.inProcess = undefined;
  }

  private async executeSmartDevicesStep(): Promise<string> {
    if (this.smartHub) {
      const devices = await this.smartHub.getDevices({ withStates: true });
      return JSON.stringify(devices.map(d => ({ name: d.name, kind: d.kind, room: d.room, state: d.switchState, switchable: d.switchCapable, platform: d.platform })));
    }
    if (!this.smartThings) return 'Smart Home not configured';
    if (!this.smartThings.isConfigured()) return 'SmartThings is not configured (set UMBRA_SMARTTHINGS_TOKEN)';
    const devices = await this.smartThings.getSmartHomeDevices({ withStates: true });
    return JSON.stringify(devices.map(d => ({ name: d.name, kind: d.kind, room: d.room, state: d.switchState, switchable: d.switchCapable })));
  }

  private async executeSmartControlStep(command: SwitchCommand, deviceName: string): Promise<string> {
    if (this.smartHub) {
      if (!deviceName) return `sm_${command} needs params.device (the device name)`;
      const r = await this.smartHub.controlByName(deviceName, command);
      return `OK: ${r.name} (${r.platform}) turned ${r.command}`;
    }
    if (!this.smartThings) return 'Smart Home not configured';
    if (!this.smartThings.isConfigured()) return 'SmartThings is not configured (set UMBRA_SMARTTHINGS_TOKEN)';
    if (!deviceName) return `sm_${command} needs params.device (the device name)`;
    const r = await this.smartThings.controlByName(deviceName, command);
    return `OK: ${r.name} turned ${r.command}`;
  }

  private async executeSmartScheduleStep(params: Record<string, unknown>): Promise<string> {
    if (!this.smartScheduler) return 'Smart Home not configured';
    const deviceName = String(params.device || params.name || '');
    const command = params.command === 'on' ? 'on' : params.command === 'off' ? 'off' : '';
    const kind = params.kind === 'at' ? 'at' : params.kind === 'everyMinutes' ? 'everyMinutes' : '';
    if (!deviceName || !command || !kind) {
      return 'sm_schedule needs params {device, command: on|off, kind: at|everyMinutes, at?: "HH:MM", everyMinutes?: number}';
    }
    if (kind === 'at' && !/^\d{2}:\d{2}$/.test(String(params.at || ''))) {
      return 'sm_schedule kind "at" needs params.at as "HH:MM" (24h)';
    }
    if (kind === 'everyMinutes' && !Number(params.everyMinutes)) {
      return 'sm_schedule kind "everyMinutes" needs params.everyMinutes (>= 1)';
    }
    // Resolve the name against the hub first so routines work on every connected
    // platform; fall back to the legacy SmartThings service for bare device ids.
    let deviceId: string;
    let resolvedName: string;
    if (this.smartHub && this.smartHub.active().length > 0) {
      const devices = await this.smartHub.getDevices({ withStates: true });
      const q = deviceName.trim().toLowerCase();
      const best = devices
        .map((d) => ({ d, score: fuzzyScore(q, d.name.toLowerCase()) }))
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score)[0];
      if (!best) return `No device matching "${deviceName}" on any connected platform`;
      deviceId = best.d.id;
      resolvedName = best.d.name;
    } else {
      if (!this.smartThings || !this.smartThings.isConfigured()) {
        return 'Smart Home is not configured — connect a platform in Smart Home → Connect';
      }
      const device = await this.smartThings.resolveDevice(deviceName);
      if (!device) return `No SmartThings device matching "${deviceName}"`;
      deviceId = device.deviceId;
      resolvedName = device.label || device.name;
    }
    const rule = this.smartScheduler.add({
      deviceId,
      deviceName: resolvedName,
      command,
      kind,
      everyMinutes: kind === 'everyMinutes' ? Number(params.everyMinutes) : undefined,
      at: kind === 'at' ? String(params.at) : undefined,
    });
    return `OK: scheduled ${rule.deviceName} ${rule.command} (${rule.kind === 'at' ? `daily at ${rule.at}` : `every ${rule.everyMinutes} min`}) — id ${rule.id}`;
  }

  /** One-shot task execution handed entirely to the dedicated reasoning engine. */
  async delegateTask(description: string, options: { provider?: string; model?: string; timeoutMs?: number } = {}): Promise<string> {
    const prompt = description;
    if (this.hermes?.isInstalled()) {
      const res = await this.hermes.runTask(prompt, options);
      if (!res.ok) throw new Error(`Agent task failed${res.error ? `: ${res.error}` : ''}`);
      return res.output;
    }
    const agent = this.inProcessAgent(options.timeoutMs);
    if (!agent) throw new Error('Dedicated reasoning engine not configured');
    const res = await agent.run(prompt);
    if (!res.ok) throw new Error(`Agent task failed${res.error ? `: ${res.error}` : ''}`);
    return res.output;
  }

  /** Build (once) the in-process agentic loop bound to this runtime's tools. */
  private inProcessAgent(timeoutMs?: number): InProcessAgent | undefined {
    if (this.inProcess) return this.inProcess;
    const tools = {
      smartHome: this.smartThings
        ? async (action: string, params: Record<string, unknown>) => {
            if (action === 'devices') {
              return JSON.stringify(await this.smartThings!.getSmartHomeDevices({ withStates: true }));
            }
            if (action === 'on' || action === 'off') {
              const r = await this.smartThings!.controlByName(String(params.device || params.name || ''), action);
              return `OK: ${r.name} turned ${r.command}`;
            }
            return `Unknown smartHome action: ${action}`;
          }
        : undefined,
      mcpCall: this.mcpRouter
        ? async (skill: string, tool: string, input: Record<string, unknown>) => {
            const r = await this.mcpRouter!.call(skill, tool, input);
            return { ok: r.ok, output: r.output, error: r.error };
          }
        : undefined,
      searchKnowledge: async (query: string) => this.knowledge.search(query),
      webSearch: this.desktop2
        ? async (query: string) => {
            await this.desktop2!.executeAction('navigate', { url: `https://www.bing.com/search?q=${encodeURIComponent(query)}` });
            return this.desktop2!.extract();
          }
        : undefined,
      browserAction: this.desktop2
        ? async (action: string, params: Record<string, unknown>) => this.desktop2!.executeAction(action, params)
        : undefined,
      desktopAction: this.realDesktop
        ? async (action: string, params: Record<string, unknown>) => this.realDesktop!.executeAction(action, params)
        : this.desktop2
          ? async (action: string, params: Record<string, unknown>) => this.desktop2!.executeAction(action, params)
          : undefined,
      fileRead: this.workspace ? (p: string) => this.workspace!.read(p) : undefined,
      fileWrite: this.workspace ? (p: string, content: string) => this.workspace!.write(p, content) : undefined,
      repoRun: this.repos
        ? async (command: string, _cwd?: string) => {
            const res = await this.repos!.run('', command, 120_000);
            return { stdout: res.stdout, stderr: res.stderr, code: res.code };
          }
        : undefined,
      connectorDiscover: this.agentConnectorBridge
        ? async (query: string, limit?: number) => {
            const tools = this.agentConnectorBridge!.getToolsForQuery(query, { limit: limit ?? 5 });
            return tools.map(t => ({
              name: t.name,
              connectorId: t.connectorId,
              description: t.description,
              authType: t.authType,
            }));
          }
        : undefined,
      connectorExecute: this.agentConnectorBridge
        ? async (connectorId: string, endpoint: string, method: string, payload: Record<string, unknown>) => {
            const r = await this.agentConnectorBridge!.executeAction(
              { connectorId, endpoint, method: method as any, payload },
              'default',
            );
            return { success: r.success, status: r.status, data: r.data, error: r.error };
          }
        : undefined,
      askUser: async (question: string, options?: string[]) => {
        if (!this.store) return { paused: false, inputId: '' };
        const task = this.activeTasks.values().next().value; // Get current task (simplified)
        if (!task) return { paused: false, inputId: '' };
        const request = await this.requestInput(task.id, question, options);
        return { paused: true, inputId: request.id };
      },
    };
    const nativeTools: NativeToolSpec | undefined = this.connectorToolRetrieval
      ? {
          getDeclarations: async (prompt: string) => {
            if (this.nativeToolCache?.prompt === prompt) return this.nativeToolCache.decls;
            const k = 6;
            let defs: ToolDefinition[] = [];
            try { defs = await this.connectorToolRetrieval!(prompt, k); } catch { defs = []; }
            const decls: LLMToolDeclaration[] = defs.map(d => ({
              type: 'function' as const,
              function: {
                name: toolFunctionName(d),
                description: `${d.natural_language_description} [connector: ${d.connector_id}]`,
                parameters: d.parameters_schema as unknown as Record<string, unknown>,
              },
            }));
            // Parity for built-in actions so native-capable models never lose
            // the JSON-contract surface when declarations are present.
            for (const key of Object.keys(tools).filter(name => typeof (tools as Record<string, unknown>)[name] === 'function')) {
              decls.push({
                type: 'function',
                function: {
                  name: `umbra_${key}`,
                  description: `Built-in Umbra action: ${key}. "input" holds the action payload.`,
                  parameters: { type: 'object', properties: { input: { type: 'object', description: 'Action payload (see tool docs).' } }, required: ['input'] },
                },
              });
            }
            this.nativeToolCache = { prompt, decls, defs };
            return decls;
          },
          execute: async call => {
            const name = call.name;
            if (name.startsWith('umbra_')) {
              const action = name.slice('umbra_'.length);
              const input = (call.arguments.input && typeof call.arguments.input === 'object'
                ? call.arguments.input
                : call.arguments) as Record<string, unknown>;
              return runBuiltinTool(tools, action, input, Number.MAX_SAFE_INTEGER);
            }
            // Connector tool: find its definition among the retrieved set.
            const defs = this.nativeToolCache?.defs ?? [];
            const def = defs.find(d => toolFunctionName(d) === name);
            if (!def) return `ERROR: unknown tool "${name}" — call connectorDiscover first`;
            const r = await this.agentConnectorBridge!.executeToolDefinition(def, call.arguments, 'default');
            if (r.validationErrors) return `VALIDATION_ERROR: ${r.validationErrors.join('; ')} — fix the arguments and retry once.`;
            return r.success
              ? `OK (${r.status}): ${typeof r.data === 'string' ? r.data : JSON.stringify(r.data).slice(0, 3000)}`
              : `ERROR (${r.status}): ${r.error || 'execution failed'}`;
          },
        }
      : undefined;

    this.inProcess = new InProcessAgent({ llm: this.llm, tools, timeoutMs, injectionGuard: this.injectionGuard, nativeTools });
    return this.inProcess;
  }

  private async webSearchStep(plannedStep: PlannedStep): Promise<string> {
    const query = String(plannedStep.params?.query || '');
    if (!query) return 'Web search needs a query';
    if (!this.desktop2) return 'No browser available for web search';

    const url = `https://www.bing.com/search?q=${encodeURIComponent(query)}`;
    await this.desktop2.executeAction('navigate', { url });
    getLogger().info({ query, url }, 'Agent: opened web search');
    // The search-results page is untrusted content from the open web — scrub
    // it before it flows into the planner/LLM so a poisoned result can't
    // hijack the task.
    const pageText = await this.desktop2.extract();
    return `Opened web search for "${query}"\n${this.injectionGuard.scrub(pageText, 'web-search').text}`;
  }

  private async thinkStep(instruction: string, params: Record<string, unknown>): Promise<string> {
    const knowledgeContext = await this.knowledge.search(instruction);
    const rawContext = JSON.stringify(knowledgeContext.slice(0, 3).map(n => ({ id: n.id, title: n.title })));

    // Graphify/Caveman: densify large knowledge context before the LLM call.
    let contextBlock = rawContext;
    if (this.graphify && rawContext.length > 1200) {
      try {
        const compressed = await this.graphify.compress(rawContext, 'think');
        if (compressed.savings > 0.2) {
          contextBlock = `[graphified: ${compressed.originalTokens}→${compressed.promptTokens} tokens, ${compressed.cliques.length} cliques]\n${compressed.prompt}`;
        }
      } catch (err: any) {
        getLogger().debug({ err: err.message }, 'Graphify compression failed — using raw context');
      }
    }

    const messages: LLMMessage[] = [
      { role: 'system', content: `You are Umbra OS. Think through this step and provide the output.
Relevant knowledge: ${contextBlock}` },
      { role: 'user', content: `${instruction}\nParams: ${JSON.stringify(params)}` },
    ];

    const result = await this.llm.complete(messages, 'reasoning', { temperature: 0.3 });
    return result.content;
  }

  /**
   * Invoke a connector tool from the MCP catalog: mcp_call {connector, tool?, input?}.
   * `connector` is the catalog id (e.g. communication-slack); tool defaults to
   * "invoke" (the generic connector binding).
   */
  private async executeMcpCallStep(plannedStep: PlannedStep): Promise<string> {
    if (!this.mcpRouter) return '[MCP router not configured]';
    const connector = String(plannedStep.params?.connector || plannedStep.params?.tool || '');
    if (!connector) return 'mcp_call needs params.connector';
    const tool = plannedStep.params?.tool && plannedStep.params.connector ? String(plannedStep.params.tool) : 'invoke';
    const input = (plannedStep.params?.input as Record<string, unknown>) || {};

    const result = await this.mcpRouter.call(connector, tool, input);
    if (!result.ok) return `Connector ${connector}.${tool} failed [${result.transport}]: ${result.error || 'unknown error'}`;
    const output = typeof result.output === 'string' ? result.output : JSON.stringify(result.output);
    return `Connector ${connector}.${tool} [${result.transport}, ${result.latencyMs}ms]: ${output.substring(0, 4000)}`;
  }

  private async executeSkillStep(task: Task, plannedStep: PlannedStep): Promise<string> {
    if (!this.skillRouter) return '[Skill system not configured]';

    const intent = String(plannedStep.params?.intent ?? plannedStep.params?.query ?? task.description);
    const startedAt = Date.now();
    const route = this.skillRouter.route(intent);

    if (!route.skill) {
      const msg = route.candidates.length > 0
        ? `No confident skill match (best ${route.candidates[0].id} @ ${route.score.toFixed(2)} < 0.4). Candidates: ${route.candidates.map(c => c.id).join(', ')}`
        : 'No matching skill found';
      this.recordSkillInvocation('none', startedAt, false, msg);
      return msg;
    }

    const skill = route.skill;
    const parts: string[] = [
      `Skill: ${skill.id} (${skill.name}) — ${skill.purpose}`,
      `Success criteria: ${skill.success}`,
    ];

    // Dispatch to a registered MCP tool when the plan names one explicitly.
    const tool = plannedStep.params?.tool ? String(plannedStep.params.tool) : undefined;
    if (tool && this.mcpRouter) {
      const input = (plannedStep.params?.input as Record<string, unknown>) || {};
      const mcpResult = await this.mcpRouter.call(skill.id, tool, input);
      if (mcpResult.ok) {
        parts.push(`Tool ${skill.id}.${tool} [${mcpResult.transport}, ${mcpResult.latencyMs}ms]: ${JSON.stringify(mcpResult.output).substring(0, 2000)}`);
      } else {
        parts.push(`Tool ${skill.id}.${tool} failed: ${mcpResult.error || 'unknown error'}`);
      }
    }

    // Ground the answer in the skill definition via the reasoning model.
    if (!this.llm) {
      this.recordSkillInvocation(skill.id, startedAt, true, parts.join('\n'));
      return parts.join('\n');
    }

    try {
      const instructions = this.skillContent?.lookup(skill.id, skill.name) ?? null;
      const messages: LLMMessage[] = [
        {
          role: 'system',
          content: `You are the "${skill.name}" skill in Umbra OS.\nPurpose: ${skill.purpose}\nSuccess criteria: ${skill.success}${instructions ? `\n\nFollow these skill instructions:\n${instructions}` : ''}\nProduce a focused, actionable response for the user's request.`,
        },
        { role: 'user', content: `Request: ${intent}` },
      ];
      const result = await this.llm.complete(messages, 'reasoning', { temperature: 0.3 });
      this.recordSkillInvocation(skill.id, startedAt, true, result.content, result.totalTokens);
      return [...parts, result.content].join('\n');
    } catch (err: any) {
      this.recordSkillInvocation(skill.id, startedAt, false, err.message);
      return [...parts, `Skill reasoning failed: ${err.message}`].join('\n');
    }
  }

  private recordSkillInvocation(skill: string, startedAt: number, ok: boolean, note: string, tokens?: number): string {
    if (!this.skillRecorder) return note;
    this.skillRecorder.record({
      skill,
      startedAt,
      durationMs: Date.now() - startedAt,
      tokens,
      result: ok ? 'success' : 'error',
    });
    return note;
  }

  private async executeDesktopStep(task: Task, plannedStep: PlannedStep): Promise<string> {
    if (this.realDesktop && (process.env['UMBRA_ENGINE'] === 'ghost')) {
      return this.executeGhostStep(task, plannedStep);
    }
    if (!this.desktop2) return this.executeSwarmStep(plannedStep);

    await this.agentDesktop?.ensure();

    const { action, params } = this.normalizeAction(plannedStep.action, plannedStep.params);
    const isUiAction = ['navigate', 'click', 'clickSelector', 'type', 'typeInto', 'pressKey', 'hotkey', 'scroll', 'extract'].includes(action);

    let beforeShot: string | null = null;
    let beforeSnap: string | null = null;
    if (isUiAction) {
      beforeShot = await this.captureScreenshot();
      beforeSnap = await this.desktop2.getAccessibilitySnapshot();
    }

    const result = await this.desktop2.executeAction(action, params);

    if (!isUiAction) return result;

    const afterShot = await this.captureScreenshot();
    const afterSnap = await this.desktop2.getAccessibilitySnapshot();
    const verification = await this.verifyStep(plannedStep.description, beforeShot, afterShot);
    const changed = beforeSnap !== afterSnap;

    const parts = [
      result,
      changed ? 'Page state changed after action' : 'Page state unchanged after action',
      verification.reason ? `Verification: ${verification.verified ? 'OK' : 'FAILED'} — ${verification.reason}` : '',
    ];
    return parts.filter(Boolean).join(' | ');
  }

  /** Ghost mode: run browser steps against the REAL Chrome profile on Desktop 2,
   *  so the agent can use the user's logged-in accounts while they work on the
   *  main desktop. Falls back to the sandbox engine if the ghost is unavailable. */
  private async executeGhostStep(task: Task, plannedStep: PlannedStep): Promise<string> {
    if (!this.realDesktop) return '[Ghost desktop not configured — using sandbox]';

    const { action, params } = this.normalizeAction(plannedStep.action, plannedStep.params);

    try {
      switch (action) {
        case 'navigate':
          return await this.realDesktop.openChrome(String(params.url || ''));
        case 'click':
          if (params.selector) return await this.realDesktop.clickSelector(String(params.selector));
          return await this.realDesktop.click(Number(params.x || 0), Number(params.y || 0));
        case 'type':
          if (params.selector) {
            const clicked = await this.realDesktop.clickSelector(String(params.selector));
            if (!clicked) return `Selector not found: ${params.selector}`;
            await new Promise(r => setTimeout(r, 150));
          }
          return await this.realDesktop.type(String(params.text || ''));
        case 'scroll':
          return await this.realDesktop.scroll(Number(params.deltaX || 0), Number(params.deltaY || 0));
        case 'extract':
          return await this.realDesktop.evaluate(`(() => {
            const sel = ${params.selector ? JSON.stringify(String(params.selector)) : 'null'};
            const el = sel ? document.querySelector(sel) : document.body;
            if (!el) return 'No element';
            return (el.innerText || el.textContent || '').trim().substring(0, ${params.maxChars ? Number(params.maxChars) : 8000});
          })()`);
        default:
          return await this.realDesktop.executeAction(action, params);
      }
    } catch (err: any) {
      getLogger().warn({ action, err: err.message }, 'Ghost step failed — falling back to sandbox desktop');
      if (!this.desktop2) throw err;
      return this.desktop2.executeAction(action, params);
    }
  }

  private async executeRealDesktopStep(task: Task, plannedStep: PlannedStep): Promise<string> {
    if (!this.realDesktop) return '[Real desktop mode not configured]';

    const { action, params } = plannedStep;
    const isUiAction = ['app_click', 'app_click_selector', 'app_type', 'app_key', 'app_hotkey', 'app_scroll', 'open_app', 'open_chrome'].includes(action);

    let beforeShot: string | null = null;
    if (isUiAction) {
      const buf = await this.realDesktop.captureWindow();
      beforeShot = buf ? buf.toString('base64') : null;
    }

    const result = await this.realDesktop.executeAction(action, params);

    if (!isUiAction) return result;

    const afterBuf = await this.realDesktop.captureWindow();
    const afterShot = afterBuf ? afterBuf.toString('base64') : null;
    const verification = await this.verifyRealStep(plannedStep.description, beforeShot, afterShot);

    const parts = [
      result,
      verification.reason ? `Verification: ${verification.verified ? 'OK' : 'FAILED'} — ${verification.reason}` : '',
    ];
    return parts.filter(Boolean).join(' | ');
  }

  private async verifyRealStep(description: string, before: string | null, after: string | null): Promise<{ verified: boolean; reason: string }> {
    if (!after) return { verified: true, reason: 'no screenshot available — skipped verification' };
    if (!this.llm) return { verified: true, reason: 'no LLM available — skipped verification' };

    const messages: LLMMessage[] = [
      {
        role: 'system',
        content: 'You are a computer-use verifier for an AI agent controlling a Windows desktop (apps and browser). Look at the screenshots (before/after an action) and decide if the action succeeded. Reply with ONLY a JSON object like {"verified": true, "reason": "short reason"}. No markdown, no prose.',
      },
      {
        role: 'user',
        content: [
          { type: 'text', text: `Did the action succeed?\nAction: ${description}` },
          ...(before ? [{ type: 'image' as const, image: before, detail: 'low' as const }] : []),
          { type: 'image', image: after, detail: 'low' },
        ],
      },
    ];

    try {
      const result = await this.llm.complete(messages, 'vision', { temperature: 0.1 });
      const jsonMatch = result.content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try {
          const parsed = JSON.parse(jsonMatch[0]);
          return { verified: parsed.verified !== false, reason: String(parsed.reason || '') };
        } catch { }
      }
      return { verified: true, reason: result.content.substring(0, 200) };
    } catch (err: any) {
      getLogger().debug({ err: err.message }, 'VLM verification failed, assuming verified');
      return { verified: true, reason: 'VLM verify unavailable' };
    }
  }

  private async executeSwarmStep(plannedStep: PlannedStep): Promise<string> {    if (!this.swarm) return '[No swarm available — simulation]';

    const swarmId = await this.swarm.acquireSwarm('generic', 'normal');
    try {
      await this.swarm.assignTask(swarmId, {
        id: crypto.randomUUID?.() || `${Date.now()}`,
        action: plannedStep.action,
        params: plannedStep.params,
      });
      return `Executed on swarm ${swarmId}`;
    } finally {
      this.swarm.releaseSwarm(swarmId);
    }
  }

  private normalizeAction(action: string, params: Record<string, unknown>): { action: string; params: Record<string, unknown> } {
    const p = { ...params };

    if (action === 'navigate') {
      const url = String(p.url || '');
      if (url && url !== 'about:blank' && !/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(url)) {
        p.url = `https://${url}`;
      }
      return { action: 'navigate', params: p };
    }

    if (action === 'click') {
      if (p.selector) return { action: 'clickSelector', params: p };
      return { action: 'click', params: p };
    }

    if (action === 'type') {
      if (p.selector) return { action: 'typeInto', params: p };
      return { action: 'type', params: p };
    }

    return { action, params: p };
  }

  private async captureScreenshot(): Promise<string | null> {
    if (!this.desktop2) return null;
    const buf = await this.desktop2.screenshot();
    return buf ? buf.toString('base64') : null;
  }

  private async verifyStep(description: string, before: string | null, after: string | null): Promise<{ verified: boolean; reason: string }> {
    if (!after) return { verified: true, reason: 'no screenshot available — skipped verification' };
    if (!this.llm) return { verified: true, reason: 'no LLM available — skipped verification' };

    const messages: LLMMessage[] = [
      {
        role: 'system',
        content: 'You are a computer-use verifier for an AI agent controlling a browser. Look at the screenshot showing the page after the action and decide if the action succeeded. Reply with ONLY a JSON object like {"verified": true, "reason": "short reason"}. No markdown, no prose.',
      },
      {
        role: 'user',
        content: [
          { type: 'text', text: `Did the action succeed?\nAction: ${description}` },
          { type: 'image', image: after, detail: 'low' },
        ],
      },
    ];

    try {
      const result = await this.llm.complete(messages, 'vision', { temperature: 0.1 });
      const jsonMatch = result.content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try {
          const parsed = JSON.parse(jsonMatch[0]);
          return { verified: parsed.verified !== false, reason: String(parsed.reason || '') };
        } catch { }
      }

      const low = result.content.toLowerCase();
      const verified = /success|verified|succeeded|completed/.test(low) && !/fail|error|unsuccessful|not verified/.test(low);
      return { verified, reason: result.content.substring(0, 200) };
    } catch (err: any) {
      getLogger().debug({ err: err.message }, 'VLM verification failed, assuming verified');
      return { verified: true, reason: 'VLM verify unavailable' };
    }
  }

  private async attemptHealing(task: Task, failedStep: PlannedStep): Promise<boolean> {
    getLogger().info({ taskId: task.id }, 'Attempting self-healing');
    eventBus.emit('healing:recovered', task.id);

    if (this.desktop2) {
      try {
        const recovered = await this.desktop2.recover();
        if (recovered) return true;
      } catch (err: any) {
        getLogger().debug({ err: err.message }, 'Desktop2 recovery failed');
      }
    }

    if (!this.healer) return false;
    try {
      const recovered = await this.healer.heal(failedStep.description);
      return recovered;
    } catch {
      return false;
    }
  }

  private async recordExecution(task: Task, steps: TaskStep[]): Promise<void> {
    if (this.memory) {
      this.memory.logActivity(task.id, task.description, 'completed', steps.length);
      // Persist the full task (plan + result) so later sessions can recall it.
      this.memory.saveTaskHistory(
        task.id,
        task.description,
        steps,
        task.result ?? null,
        task.status,
        task.result?.totalTimeMs ?? 0,
      );
      try {
        await this.memory.addVector(
          'task',
          task.id,
          `${task.description}\n${(task.result?.summary || '').slice(0, 800)}`,
        );
      } catch {
        // Memory embedding is best-effort — never fail the task over it.
      }
    }

    await this.knowledge.learnFromExecution(
      task.description,
      steps.map(s => s.description),
      this.injectionGuard.scrub(steps.map(s => s.result || s.error || '').join('\n'), 'step-results').text
    );
  }

  async cancelTask(taskId: string): Promise<void> {
    const task = this.activeTasks.get(taskId);
    if (task) {
      task.status = 'cancelled';
      this.persist(task); // kept in the durable queue so it can be retried later
      eventBus.emit('task:cancelled', taskId);
    }
  }

  getActiveTasks(): Task[] {
    return Array.from(this.activeTasks.values()).filter(t => t.status === 'pending' || t.status === 'planning' || t.status === 'executing' || t.status === 'healing');
  }

  /**
   * Retry a task that ended in a terminal state. Failed/cancelled tasks are
   * archived in the durable queue (only completed tasks are removed), so the
   * original plan is found even after a restart — it is re-submitted under the
   * same id and the resume path continues from the checkpoint without
   * re-planning. If the original is unknown, a new task is created from the
   * description.
   */
  async retryTask(taskId: string, description?: string, priority: number = 0): Promise<Task> {
    let original = this.activeTasks.get(taskId) ?? this.store?.loadAll().find(t => t.id === taskId);
    if (original && (original.status !== 'failed' && original.status !== 'cancelled')) {
      original = undefined; // only terminal tasks can be retried
    }
    const desc = original?.description ?? description ?? '';
    if (!desc) throw new Error('No description available to retry this task');

    if (original) {
      // Re-submit under the same id: executeTask sees the existing plan and
      // resumes from the checkpoint instead of re-planning from scratch.
      original.status = 'pending';
      original.error = undefined;
      original.completedStepCount = 0;
      this.activeTasks.set(original.id, original);
      this.persist(original);
      eventBus.emit('task:created', original.id);
      getLogger().info({ taskId: original.id }, 'Task retried');
      this.executeTask(original).catch(err => {
        getLogger().error({ taskId: original.id, err }, 'Retried task execution failed');
      });
      return original;
    }

    return this.submitTask(desc, priority);
  }

  /**
   * Attempt to claim a task lease for this worker.
   * Returns the task if claim succeeded, undefined if another worker owns it.
   */
  async workerClaim(taskId: string, workerId: string): Promise<Task | undefined> {
    if (!this.store) return undefined;

    const task = this.store.loadAll().find(t => t.id === taskId);
    if (!task) return undefined;

    // Check if task is in a claimable state
    const claimableStates = ['pending', 'planning', 'executing', 'healing', 'waiting_input', 'paused'];
    if (!claimableStates.includes(task.status)) {
      return undefined;
    }

    // Try to acquire lease via CAS
    const now = new Date().toISOString();
    const deadline = new Date(Date.now() + 60000).toISOString(); // 60s lease
    const updated = this.store.compareAndSwap(taskId, task.version ?? 0, {
      leaseOwner: workerId,
      leaseDeadline: deadline,
      status: task.status === 'pending' ? 'executing' : task.status,
    });

    if (updated) {
      this.logActivity(taskId, 'Lease acquired', `Worker ${workerId} claimed task`, 'info');
      this.activeTasks.set(updated.id, updated);
      eventBus.emit('task:started', taskId);
      return updated;
    }
    return undefined;
  }

  /**
   * Extend the lease deadline for a task this worker owns.
   * Returns true if extension succeeded, false if lease was lost.
   */
  async workerHeartbeat(taskId: string, workerId: string): Promise<boolean> {
    if (!this.store) return false;

    const task = this.activeTasks.get(taskId) ?? this.store.loadAll().find(t => t.id === taskId);
    if (!task || task.leaseOwner !== workerId) return false;

    const deadline = new Date(Date.now() + 60000).toISOString(); // 60s lease
    const updated = this.store.compareAndSwap(taskId, task.version ?? 0, {
      leaseDeadline: deadline,
    });

    if (updated) {
      this.activeTasks.set(updated.id, updated);
      return true;
    }
    return false;
  }

  /**
   * Release a task lease (called on completion/failure/cancellation).
   */
  async workerRelease(taskId: string, workerId: string): Promise<void> {
    if (!this.store) return;

    const task = this.activeTasks.get(taskId) ?? this.store.loadAll().find(t => t.id === taskId);
    if (!task || task.leaseOwner !== workerId) return;

    const updated = this.store.compareAndSwap(taskId, task.version ?? 0, {
      leaseOwner: undefined,
      leaseDeadline: undefined,
    });

    if (updated) {
      this.activeTasks.set(updated.id, updated);
    }
  }

  /**
   * On startup, find tasks with expired leases and reclaim them for this worker.
   * Returns the number of tasks reclaimed.
   */
  async workerRecover(workerId: string): Promise<number> {
    if (!this.store) return 0;

    const now = new Date();
    let reclaimed = 0;

    for (const task of this.store.loadUnfinished()) {
      if (!task.leaseDeadline) continue;
      const deadline = new Date(task.leaseDeadline);
      if (deadline <= now) {
        // Lease expired — try to reclaim
        const reclaimedTask = await this.workerClaim(task.id, workerId);
        if (reclaimedTask) {
          reclaimed++;
          getLogger().info({ taskId: task.id, workerId }, 'Reclaimed task with expired lease');
        }
      }
    }

    if (reclaimed > 0) {
      getLogger().info({ reclaimed, workerId }, 'Worker recovery complete');
    }
    return reclaimed;
  }

  getTask(taskId: string): Task | undefined {
    return this.activeTasks.get(taskId);
  }

  getTaskActivity(taskId: string): ActivityEntry[] {
    return this.store?.getActivity(taskId) ?? [];
  }

  // Action proposal review flow (delegates to ConsentGate)
  async proposeAction(taskId: string, action: string, args: Record<string, unknown>, idempotencyKey?: string): Promise<ActionProposal> {
    if (!this.consent) throw new Error('ConsentGate not configured');
    return this.consent.proposeAction(taskId, action, args, idempotencyKey);
  }

  async reviewAction(proposalId: string, approved: boolean, hash: string): Promise<{ success: boolean; proposal?: ActionProposal; error?: string }> {
    if (!this.consent) throw new Error('ConsentGate not configured');
    return this.consent.reviewAction(proposalId, { approved, hash });
  }

  async getProposal(proposalId: string): Promise<ActionProposal | undefined> {
    if (!this.consent) throw new Error('ConsentGate not configured');
    return this.consent.getProposal(proposalId);
  }

  async listProposals(taskId: string): Promise<ActionProposal[]> {
    if (!this.consent) throw new Error('ConsentGate not configured');
    return this.consent.listProposals(taskId);
  }

  // waiting_input pause/resume
  async requestInput(taskId: string, question: string, options?: string[]): Promise<InputRequest> {
    if (!this.store) throw new Error('TaskStore not configured');
    const task = this.activeTasks.get(taskId) ?? this.store.loadAll().find(t => t.id === taskId);
    if (!task) throw new Error('Task not found');

    // Set task status to waiting_input
    task.status = 'waiting_input';
    this.persist(task);
    this.logActivity(taskId, 'Input requested', question, 'warning');

    const request = this.store.createInputRequest(taskId, question, options);
    eventBus.emit('task:input_requested', taskId, { question, options, inputId: request.id });
    return request;
  }

  async submitInput(taskId: string, inputId: string, answer: string): Promise<{ success: boolean; task?: Task; error?: string }> {
    if (!this.store) throw new Error('TaskStore not configured');

    const answered = this.store.answerInputRequest(taskId, inputId, answer);
    if (!answered) {
      return { success: false, error: 'Input request not found' };
    }

    // Check if all input requests for this task are answered
    const pending = this.store.getPendingInputRequest(taskId);
    const task = this.activeTasks.get(taskId) ?? this.store.loadAll().find(t => t.id === taskId);
    if (!task) return { success: false, error: 'Task not found' };

    if (!pending) {
      // All inputs answered — resume execution
      task.status = 'executing';
      this.persist(task);
      this.logActivity(taskId, 'Input received', `Resuming execution with answer: ${answer}`, 'info');
      eventBus.emit('task:input_received', taskId, { inputId, answer });
      // Note: The actual resumption of execution happens in the main loop
    }

    return { success: true, task };
  }
}
