/**
 * Live connector test — exercises the real McpHttpConnector + McpRouter code
 * path against DeepWiki's public, no-auth MCP endpoint (streamable HTTP/SSE).
 *
 * Run:  npx ts-node scripts/live-connector-test.ts
 */
import { McpRegistry } from '../src/core/mcp/McpRegistry';
import { McpRouter } from '../src/core/mcp/McpRouter';
import { McpHttpConnector } from '../src/core/mcp/McpHttpConnector';

async function main() {
  const registry = new McpRegistry();
  registry.register('deepwiki', 'ask_question', {
    transport: 'http',
    endpoint: 'https://mcp.deepwiki.com/mcp',
  });
  const connector = new McpHttpConnector({ timeoutMs: 60_000 });
  const router = new McpRouter(registry, { connector });

  const res = await router.call('deepwiki', 'ask_question', {
    repoName: 'ggml-org/whisper.cpp',
    question: 'In one sentence, what does whisper.cpp do?',
  });

  const output = typeof res.output === 'string' ? res.output.trim() : JSON.stringify(res.output);
  console.log(JSON.stringify({
    ok: res.ok,
    transport: res.transport,
    latencyMs: res.latencyMs,
    error: res.error,
    answer: output.slice(0, 400),
  }, null, 2));
  console.log('LIVE_CONNECTOR_TEST_' + (res.ok && !res.error ? 'PASS' : 'FAIL'));
}

main().catch(err => {
  console.error('LIVE_CONNECTOR_TEST_FAIL', err);
  process.exit(1);
});
