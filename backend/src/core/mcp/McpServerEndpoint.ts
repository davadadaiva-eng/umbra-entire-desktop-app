/**
 * McpServerEndpoint — exposes Umbra's registered connector tools as a
 * Model Context Protocol (Streamable HTTP) server, so an external agent
 * (the built-in reasoning engine) can call every connected connector
 * through Umbra — with vault-backed credentials, gated by the same router
 * the agent loop uses.
 *
 * Only the POST JSON-RPC surface is implemented (initialize, ping,
 * tools/list, tools/call); the MCP client we integrate with never opens the
 * optional GET SSE stream unless it receives a session-terminated error,
 * which this server never sends.
 */

import { McpRegistry } from './McpRegistry';
import { McpRouter } from './McpRouter';

export interface McpJsonRpcError {
  code: number;
  message: string;
}

export interface McpJsonRpcResponse {
  jsonrpc: string;
  id: number | string | null;
  result?: unknown;
  error?: McpJsonRpcError;
}

const PROTOCOL_VERSION = '2025-03-26';
const SERVER_NAME = 'umbra';
const SERVER_VERSION = '0.1.0';

export class McpServerEndpoint {
  private registry: McpRegistry;
  private router: McpRouter;

  constructor(registry: McpRegistry, router: McpRouter) {
    this.registry = registry;
    this.router = router;
  }

  /**
   * Handle a single JSON-RPC message. Returns null for notifications
   * (which must not be answered with a response).
   */
  async handle(message: Record<string, unknown>): Promise<McpJsonRpcResponse | null> {
    const method = String(message.method || '');
    const id = (message.id ?? null) as number | string | null;
    if (id === null) {
      // Notifications: no response required by the protocol.
      return null;
    }
    try {
      switch (method) {
        case 'initialize':
          return {
            jsonrpc: '2.0',
            id,
            result: {
              protocolVersion: PROTOCOL_VERSION,
              capabilities: { tools: {} },
              serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
            },
          };
        case 'ping':
          return { jsonrpc: '2.0', id, result: {} };
        case 'tools/list':
          return { jsonrpc: '2.0', id, result: { tools: this.listTools() } };
        case 'tools/call':
          return { jsonrpc: '2.0', id, ...(await this.callTool(message.params as Record<string, unknown>)) };
        default:
          return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
      }
    } catch (err: any) {
      return { jsonrpc: '2.0', id, error: { code: -32603, message: err?.message || 'Internal error' } };
    }
  }

  private listTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
    return this.registry.list().map(binding => ({
      name: binding.key,
      description: `Connector tool: ${binding.skill}.${binding.tool} (${binding.transport} transport).`,
      inputSchema: { type: 'object', properties: {} },
    }));
  }

  private async callTool(
    params?: Record<string, unknown>,
  ): Promise<Pick<McpJsonRpcResponse, 'result' | 'error'>> {
    const name = String((params && params['name']) || '');
    const args =
      params?.arguments && typeof params.arguments === 'object'
        ? (params.arguments as Record<string, unknown>)
        : {};
    const dot = name.lastIndexOf('.');
    if (dot <= 0 || dot === name.length - 1) {
      return { error: { code: -32602, message: `Invalid tool name: ${name}` } };
    }
    const skill = name.slice(0, dot);
    const tool = name.slice(dot + 1);

    const result = await this.router.call(skill, tool, args);
    const text = result.ok
      ? typeof result.output === 'string'
        ? result.output
        : JSON.stringify(result.output)
      : `Error: ${result.error || 'unknown error'}`;
    return { result: { content: [{ type: 'text', text }], isError: !result.ok } };
  }
}
