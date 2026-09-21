/**
 * Pairing server — a lightweight boot of the PWA + QR pairing + signaling
 * planes, so a phone/tablet can pair with this PC without launching the full
 * desktop OS. It also runs a REAL agent (on the local model) so the tablet's
 * "Ask Umbra" executes tasks instead of returning a stub, streams a REAL
 * desktop screenshot as the live-view frame, and shows a tray-style overlay
 * on the PC with the pairing link + QR.
 *
 * Paired devices persist to the real data dir (~/.umbra/p2p-paired.json), so
 * a later `npm run dev` keeps them paired (hello/reconnect, no re-scan).
 *
 *   npx ts-node scripts/pairing-server.ts
 *
 *   Phone/tablet: http://<PC-LAN-IP>:9443  →  Auto-pair
 *   QR page (PC): http://localhost:9443/pair
 *
 * Env:
 *   UMBRA_DATA_DIR           data directory (default ~/.umbra)
 *   UMBRA_LOCAL_MODEL        local OpenAI-compatible endpoint (default http://127.0.0.1:8080/v1)
 *   UMBRA_LOCAL_MODEL_NAME   local model name (default qwen2.5-0.5b-instruct)
 *   UMBRA_PAIRING_OVERLAY=0  disable the tray-style link+QR overlay
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PairingManager } from '../src/p2p/PairingManager';
import { P2PConnectionManager } from '../src/p2p/P2PConnectionManager';
import { PwaServer } from '../src/mobile/PwaServer';
import { PairingOverlay } from '../src/overlay/PairingOverlay';
import { captureScreenPng } from '../src/native/win32/ScreenCaptureNative';
import { ConfigManager } from '../src/config/ConfigManager';
import { LLMConnector } from '../src/core/agent/LLMConnector';
import { TaskPlanner } from '../src/core/agent/TaskPlanner';
import { AgentRuntime } from '../src/core/agent/AgentRuntime';
import { TaskStore } from '../src/core/agent/TaskStore';
import { KnowledgeGraph } from '../src/knowledge/KnowledgeGraph';
import { VectorMemory } from '../src/core/memory/VectorMemory';
import { WorkspaceFiles } from '../src/core/agent/WorkspaceFiles';
import { UmbraConfig } from '../src/types';

const WEB_PORT = 9443;
const SIGNALING_PORT = 9444;

function lanHost(): string {
  for (const name of Object.keys(os.networkInterfaces())) {
    for (const n of os.networkInterfaces()[name] || []) {
      if (n.family === 'IPv4' && !n.internal) return n.address;
    }
  }
  return 'localhost';
}

/**
 * Build a minimal but real agent: loads the user's config, prefers it when it
 * has real credentials, otherwise falls back to the free local model
 * (llama.cpp / llama-server) installed in the Umbra folder.
 */
async function buildAgent(dataDir: string): Promise<{ agent: AgentRuntime; llm: LLMConnector; provider: string }> {
  const cm = new ConfigManager(dataDir);
  await cm.initialize();
  const config = cm.raw;

  const hasCloud =
    (config.provider === 'openai' && !!config.openai?.apiKey) ||
    (config.provider === 'anthropic' && !!config.anthropic?.apiKey) ||
    (config.provider === 'openai-compatible' && !!config.openaiCompatible?.endpoint);

  let agentConfig: UmbraConfig = config;
  if (!hasCloud) {
    const endpoint = process.env.UMBRA_LOCAL_MODEL || 'http://127.0.0.1:8080/v1';
    const model = process.env.UMBRA_LOCAL_MODEL_NAME || 'qwen2.5-0.5b-instruct';
    agentConfig = {
      ...config,
      provider: 'openai-compatible',
      openaiCompatible: { endpoint, apiKey: '' },
      models: { ...config.models, fast: model, reasoning: model, vision: model },
    };
  }

  const llm = new LLMConnector(agentConfig);
  const knowledge = new KnowledgeGraph(config.paths.knowledgeDir);
  await knowledge.initialize();
  const memory = new VectorMemory(config.paths.recallDb, { enableVec: true });
  memory.initialize();
  const planner = new TaskPlanner(knowledge, llm, memory);
  const workspace = new WorkspaceFiles(path.join(dataDir, 'workspace'));
  const agent = new AgentRuntime(llm, knowledge, planner, workspace);
  const store = new TaskStore(path.join(dataDir, 'task-queue'));
  agent.registerSubsystems({ memory, taskStore: store, nodeRole: 'desktop' });

  return { agent, llm, provider: agentConfig.provider };
}

async function pingModel(llm: LLMConnector): Promise<void> {
  try {
    const res = await llm.complete([{ role: 'user', content: 'Reply with exactly: ok' }], 'fast', {
      maxTokens: 8,
      temperature: 0,
    });
    console.log('MODEL_OK model=' + res.modelUsed);
  } catch (err: any) {
    console.warn('MODEL_UNREACHABLE ' + (err.message || '') + ' — start it with scripts/start-local-model.sh');
  }
}

async function main() {
  const dataDir = process.env.UMBRA_DATA_DIR || path.join(os.homedir(), '.umbra');
  fs.mkdirSync(dataDir, { recursive: true });

  const { agent, llm, provider } = await buildAgent(dataDir);
  pingModel(llm);

  const pairing = new PairingManager({ dataDir });

  const p2p = new P2PConnectionManager({
    signalingPort: SIGNALING_PORT,
    stunServers: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'],
    relayFps: 10,
    pairing,
    commandHandler: async (action, params, deviceId) => {
      switch (action) {
        case 'submitTask': {
          const description = String(params?.description || '').trim();
          if (!description) return 'No task description provided';
          const task = await agent.submitTask(description);
          return `Task ${task.id} accepted — running on the local agent`;
        }
        case 'ping':
          return 'pong';
        default:
          return `Handled ${action} for ${deviceId}`;
      }
    },
    // Real desktop screenshot so the tablet sees live video without the full app.
    frameProvider: async () => {
      try {
        const shot = await captureScreenPng();
        return shot?.buffer ?? null;
      } catch {
        return null;
      }
    },
    webrtcConfig: null,
  });
  p2p.start();

  const pwa = new PwaServer({
    webPort: WEB_PORT,
    signalingPort: SIGNALING_PORT,
    pairing,
    getStatus: () => {
      const s = p2p.getStatus();
      return { active: s.active, clients: s.clients, pairedDevices: s.pairedDevices };
    },
    onChat: async (message, _target) => {
      const task = await agent.submitTask(message);
      return { taskId: task.id, target: 'local' };
    },
  });
  pwa.start();

  // Phone-home check: a tray-style overlay on the PC showing the link + QR,
  // auto-refreshing so the payload never expires.
  const overlay = new PairingOverlay(dataDir);
  if (process.env.UMBRA_PAIRING_OVERLAY !== '0') {
    overlay
      .start({
        getLink: () => `http://${lanHost()}:${WEB_PORT}`,
        getPayloadJson: () => pairing.qrPayload(lanHost(), SIGNALING_PORT),
      })
      .catch(err => console.warn('Pairing overlay failed: ' + (err.message || err)));
  }

  console.log('PAIRING_SERVER_READY');
  console.log('Phone/tablet link: http://' + lanHost() + ':' + WEB_PORT);
  console.log('QR page (on PC):   http://localhost:' + WEB_PORT + '/pair');
  console.log('Agent provider:    ' + provider);
  console.log('Data dir:          ' + dataDir);

  const shutdown = () => {
    overlay.close();
    p2p.stop();
    pwa.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch(err => {
  console.error('PAIRING_SERVER_FAIL', err);
  process.exit(1);
});
