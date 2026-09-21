/**
 * McpRouter — resolves a tool call to a handler. The LLM can chain any
 * registered tool regardless of transport; the router hides that from it.
 */

import { McpRegistry, McpToolBinding } from './McpRegistry';
import { McpHttpConnector } from './McpHttpConnector';

export interface McpCallContext {
  tool: string;
  skill: string;
  input: Record<string, unknown>;
}

export interface McpCallResult {
  ok: boolean;
  output: unknown;
  transport: string;
  latencyMs: number;
  error?: string;
}

export interface RouterOptions {
  connector?: McpHttpConnector;
  /** Native handler resolver (skill → (input) => output). */
  nativeHandlers?: Map<string, (input: Record<string, unknown>) => unknown>;
  /**
   * Fallback resolver consulted when a native binding has no map entry — lets
   * dynamically-registered tools (e.g. OpenMontage) dispatch without a
   * pre-populated handler map.
   */
  nativeResolver?: (binding: McpToolBinding) => ((input: Record<string, unknown>) => unknown) | undefined;
}

export class McpRouter {
  private registry: McpRegistry;
  private connector?: McpHttpConnector;
  private nativeHandlers: Map<string, (input: Record<string, unknown>) => unknown>;
  private nativeResolver?: (binding: McpToolBinding) => ((input: Record<string, unknown>) => unknown) | undefined;

  constructor(registry: McpRegistry, options: RouterOptions = {}) {
    this.registry = registry;
    this.connector = options.connector;
    this.nativeHandlers = options.nativeHandlers ?? new Map();
    this.nativeResolver = options.nativeResolver;
  }

  async call(skill: string, tool: string, input: Record<string, unknown>): Promise<McpCallResult> {
    const binding = this.registry.resolve(skill, tool);
    if (!binding) {
      return { ok: false, output: null, transport: 'none', latencyMs: 0, error: `Unknown tool ${skill}.${tool}` };
    }
    const started = Date.now();
    try {
      const output = await this.dispatch(binding, input);
      return { ok: true, output, transport: binding.transport, latencyMs: Date.now() - started };
    } catch (err) {
      return {
        ok: false,
        output: null,
        transport: binding.transport,
        latencyMs: Date.now() - started,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private async dispatch(binding: McpToolBinding, input: Record<string, unknown>): Promise<unknown> {
    switch (binding.transport) {
      case 'native': {
        const handler = this.nativeHandlers.get(binding.key) ?? this.nativeResolver?.(binding);
        if (!handler) throw new Error(`No native handler for ${binding.key}`);
        return handler(input);
      }
      case 'http': {
        if (!this.connector) throw new Error('No HTTP connector configured');
        return this.connector.call(binding, input);
      }
      case 'prompt':
      default:
        return { invoked: binding.key, input };
    }
  }
}
