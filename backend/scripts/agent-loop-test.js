const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');

const umbra = 'C:\\Users\\User1\\.claude\\Nuova cartella\\davide\\umbra';
const { KnowledgeGraph } = require(path.join(umbra, 'dist', 'knowledge', 'KnowledgeGraph.js'));
const { LLMConnector } = require(path.join(umbra, 'dist', 'core', 'agent', 'LLMConnector.js'));
const { TaskPlanner } = require(path.join(umbra, 'dist', 'core', 'agent', 'TaskPlanner.js'));
const { AgentRuntime } = require(path.join(umbra, 'dist', 'core', 'agent', 'AgentRuntime.js'));
const { ConsentGate } = require(path.join(umbra, 'dist', 'core', 'agent', 'ConsentGate.js'));
const { Desktop2Environment } = require(path.join(umbra, 'dist', 'core', 'desktop2', 'Desktop2Environment.js'));
const { PrivacyGuard } = require(path.join(umbra, 'dist', 'core', 'privacy', 'PrivacyGuard.js'));
const { AuditVault } = require(path.join(umbra, 'dist', 'core', 'vault', 'AuditVault.js'));

const config = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.umbra', 'config.json'), 'utf-8'));
const dataDir = path.join(os.tmpdir(), 'agent-loop-test-' + Date.now());
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(path.join(dataDir, 'vault'), { recursive: true });

function fail(msg) { console.log('FAIL: ' + msg); process.exit(1); }

async function main() {
  const kg = new KnowledgeGraph(path.join(dataDir, 'knowledge'));
  await kg.initialize();

  const llm = new LLMConnector(config);
  const planner = new TaskPlanner(kg, llm);
  const consent = new ConsentGate({ dataDir, promptTimeoutMs: 15000, askOncePerSession: true });
  const vault = new AuditVault(path.join(dataDir, 'vault'));
  vault.initialize();

  const fakeDisplays = {
    async create() { return { id: 1, width: 1280, height: 720, name: 'fake-d2' }; },
    async destroy() { },
  };
  const fakeInput = { registerVirtualDisplay() { }, unregisterVirtualDisplay() { } };

  const d2 = new Desktop2Environment(fakeDisplays, fakeInput, new PrivacyGuard(), vault, {
    width: 1280, height: 720, fps: 5, browserPath: '', dataDir, browserPort: 9222,
  }, consent);

  const agent = new AgentRuntime(llm, kg, planner);
  agent.registerSubsystems({ consent, desktop2: d2 });

  await d2.start();

  const task = await agent.submitTask('Open example.com and report the page title', 1);
  console.log('Task ' + task.id + ' submitted, waiting...');

  const deadline = Date.now() + 240000;
  while (Date.now() < deadline) {
    const t = agent.getTask(task.id);
    if (t && (t.status === 'completed' || t.status === 'failed' || t.status === 'cancelled')) {
      console.log('STATUS: ' + t.status);
      if (t.result && t.result.steps) {
        for (const s of t.result.steps) {
          console.log('  step [' + s.action + '] ' + s.description);
          console.log('    -> ' + String(s.result || s.error).substring(0, 400));
        }
      }
      if (t.error) console.log('ERROR: ' + t.error);

      const completed = t.status === 'completed';
      const titleFound = JSON.stringify(t.result || t.error || '').includes('Example Domain');
      if (completed) {
        if (titleFound) { console.log('PASS: A5 AGENT LOOP — task completed, page title extracted'); }
        else { console.log('WARN: completed but title not found in results'); }
        process.exit(titleFound ? 0 : 3);
      }
      process.exit(1);
    }
    await new Promise(r => setTimeout(r, 1000));
  }
  fail('task timed out after 240s');
}

main().catch(e => fail(e.message));
