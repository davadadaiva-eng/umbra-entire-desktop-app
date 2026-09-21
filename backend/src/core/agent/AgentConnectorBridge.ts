/**
 * AgentConnectorBridge — bridges the agent loop to the connector system.
 *
 * Provides dynamic tool discovery, multi-step execution, and error
 * handling for connector-based actions. Integrates with the existing
 * AgentRuntime via the subsystem registration pattern.
 */

import { ToolRetriever, ConnectorTool, RetrievalOptions } from '../mcp/ToolRetriever';
import { ToolExecutor, ToolResult, ExecuteOptions } from '../mcp/ToolExecutor';
import { ConnectorStore } from '../mcp/ConnectorStore';
import { getLogger } from '../Logger';

// ── Types ───────────────────────────────────────────────────────────

export interface AgentConnectorResult {
  /** Final text response for the user. */
  finalText: string;
  /** All executed tool calls. */
  executedTools: ToolResult[];
  /** Number of steps executed. */
  stepsCount: number;
  /** Any errors encountered. */
  errors: string[];
}

export interface ConnectorAction {
  connectorId: string;
  endpoint: string;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  payload: Record<string, unknown>;
}

export interface AgentConnectorBridgeOptions {
  /** Max steps per execution (default: 5). */
  maxSteps?: number;
  /** Default timeout per action (default: 30_000). */
  timeoutMs?: number;
}

// ── AgentConnectorBridge ────────────────────────────────────────────

export class AgentConnectorBridge {
  private retriever: ToolRetriever;
  private executor: ToolExecutor;
  private options: AgentConnectorBridgeOptions;

  constructor(
    store: ConnectorStore,
    options: AgentConnectorBridgeOptions = {},
  ) {
    this.retriever = new ToolRetriever();
    this.executor = new ToolExecutor(store);
    this.options = {
      maxSteps: options.maxSteps ?? 5,
      timeoutMs: options.timeoutMs ?? 30_000,
    };
  }

  /**
   * Get relevant tools for a user query (for LLM function declarations).
   *
   * @param userQuery - Natural language description of what the user wants
   * @param options - Retrieval options
   * @returns Array of connector tools formatted for LLM function calling
   */
  getToolsForQuery(userQuery: string, options: RetrievalOptions = {}): ConnectorTool[] {
    return this.retriever.getRelevantTools(userQuery, {
      limit: options.limit ?? 5,
      ...options,
    });
  }

  /**
   * Execute a connector action (called by the LLM via function calling).
   *
   * Maps a function call from the LLM to a ToolExecutor.execute() call.
   *
   * @param action - The action to execute
   * @param userId - User ID for credential lookup
   * @returns ToolResult with status, data, and latency
   */
  async executeAction(
    action: ConnectorAction,
    userId: string,
    options: ExecuteOptions = {},
  ): Promise<ToolResult> {
    getLogger().info({
      connectorId: action.connectorId,
      endpoint: action.endpoint,
      method: action.method,
      userId,
    }, 'Executing connector action');

    return this.executor.execute(
      action.connectorId,
      action.endpoint,
      action.method,
      action.payload,
      userId,
      { timeoutMs: this.options.timeoutMs, ...options },
    );
  }

  /**
   * Execute a multi-step workflow across connectors.
   *
   * Takes an array of actions and executes them sequentially,
   * collecting results and stopping on unrecoverable errors.
   *
   * @param actions - Array of actions to execute
   * @param userId - User ID for credential lookup
   * @returns AgentConnectorResult with all results and final text
   */
  async executeWorkflow(
    actions: ConnectorAction[],
    userId: string,
  ): Promise<AgentConnectorResult> {
    const results: ToolResult[] = [];
    const errors: string[] = [];
    const maxSteps = Math.min(actions.length, this.options.maxSteps!);

    for (let i = 0; i < maxSteps; i++) {
      const action = actions[i];
      const result = await this.executeAction(action, userId);
      results.push(result);

      if (!result.success) {
        errors.push(`Step ${i + 1}: ${result.error}`);

        // Stop on connection errors (user needs to connect the app)
        if (result.error?.includes('has not connected')) {
          break;
        }

        // Stop on auth errors that can't be refreshed
        if (result.status === 401 || result.status === 403) {
          break;
        }
      }
    }

    // Build final text summary
    const finalText = this.buildSummary(results, errors);

    return {
      finalText,
      executedTools: results,
      stepsCount: results.length,
      errors,
    };
  }

  /**
   * Parse an LLM function call into a ConnectorAction.
   *
   * Handles the mapping from LLM function name format
   * (e.g. `gmail_execute_action`) back to connector ID.
   */
  parseFunctionCall(functionName: string, args: Record<string, unknown>): ConnectorAction | null {
    // Pattern: {connector_id}_execute_action
    const match = functionName.match(/^(.+)_execute_action$/);
    if (!match) return null;

    // Convert underscored ID back to connector slug
    const connectorId = match[1].replace(/_/g, '-');

    return {
      connectorId,
      endpoint: (args.endpoint as string) || '/',
      method: (args.method as string)?.toUpperCase() as ConnectorAction['method'] || 'GET',
      payload: (args.payload as Record<string, unknown>) || {},
    };
  }

  /**
   * Search connectors (for marketplace UI).
   */
  searchConnectors(query: string, options: { category?: string; limit?: number } = {}) {
    return this.retriever.searchConnectors(query, options);
  }

  /**
   * Get all categories with counts.
   */
  getCategories() {
    return this.retriever.getCategories();
  }

  /**
   * List user's connected connectors.
   */
  listUserConnections(userId: string) {
    return this.executor.listUserConnections(userId);
  }

  /**
   * Disconnect a user from a connector.
   */
  disconnect(userId: string, connectorId: string): boolean {
    return this.executor.disconnect(userId, connectorId);
  }

  /**
   * Build a human-readable summary of executed tools.
   */
  private buildSummary(results: ToolResult[], errors: string[]): string {
    if (results.length === 0) {
      return 'No connector actions were executed.';
    }

    const successful = results.filter(r => r.success);
    const failed = results.filter(r => !r.success);

    const parts: string[] = [];

    if (successful.length > 0) {
      const connectors = [...new Set(successful.map(r => r.connector))];
      parts.push(`Successfully executed ${successful.length} action(s) on ${connectors.join(', ')}.`);
    }

    if (failed.length > 0) {
      const failedConnectors = [...new Set(failed.map(r => r.connector))];
      parts.push(`Failed: ${failed.map(r => `${r.connector}${r.endpoint} (${r.error || 'unknown error'})`).join('; ')}`);
    }

    return parts.join(' ');
  }
}
