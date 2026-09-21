/**
 * Test harness — runs the REAL Umbra DeviceHub + DeviceRegistry (unmodified)
 * with a mock desktop agent (a real DeviceClient) so the mobile app can pair
 * and receive genuine task lifecycle events over the mesh.
 *
 *   node_modules/.bin/ts-node scripts/test-mobile-hub.ts
 *
 * Ports: REST join/invite on 9443, DeviceHub WS on 8788.
 */
import * as http from 'http';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DeviceHub } from '../src/p2p/DeviceHub';
import { DeviceRegistry } from '../src/p2p/DeviceRegistry';
import { DeviceClient } from '../src/p2p/DeviceClient';

const REST_PORT = 9446;
const HUB_PORT = 8788;

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'umbra-hub-'));

function json(res: http.ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Content-Length': Buffer.byteLength(data),
  });
  res.end(data);
}

function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      try {
        resolve(JSON.parse(b));
      } catch {
        resolve({});
      }
    });
  });
}

async function main(): Promise<void> {
  const registry = new DeviceRegistry({ dataDir });

  // Register the mock desktop FIRST so the phone sees it online on the mesh.
  const desktopReg = registry.redeemInvite(registry.createInvite('Desktop').code, {
    name: 'Test Desktop',
    role: 'desktop',
    capabilities: ['desktop-control', 'agent'],
  });

  // ── REST: just the invite + join endpoints the app needs to pair ──
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://localhost:${REST_PORT}`);
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/devices/invite') {
      const body = await readBody(req);
      const invite = registry.createInvite(String(body.name || 'Phone'));
      return json(res, 200, {
        code: invite.code,
        expiresAt: invite.expiresAt,
        joinUrl: `http://localhost:${REST_PORT}/api/devices/join?code=${invite.code}`,
        hubWsUrl: `ws://localhost:${HUB_PORT}/device-ws`,
      });
    }
    if (req.method === 'POST' && url.pathname === '/api/devices/join') {
      const body = await readBody(req);
      try {
        const j = registry.redeemInvite(String(body.code || ''), {
          name: String(body.name || 'Phone'),
          role: (body.role as 'phone') || 'phone',
          capabilities: Array.isArray(body.capabilities)
            ? (body.capabilities as string[])
            : ['control', 'voice'],
        });
        return json(res, 200, {
          join: {
            deviceId: j.deviceId,
            token: j.token,
            name: j.device.name,
            role: j.device.role,
            deviceLimit: 'unlimited',
            hubWsUrl: `ws://localhost:${HUB_PORT}/device-ws`,
          },
        });
      } catch (err) {
        return json(res, 400, { error: (err as Error).message });
      }
    }
    if (req.method === 'POST' && url.pathname === '/api/chat') {
      const body = await readBody(req);
      const message = String(body.message || '');
      // Route to the online desktop: the agent will emit the task lifecycle
      // over the mesh exactly like TaskSyncBridge + AgentRuntime do.
      const desk = registry
        .listDevices()
        .find((d) => d.role === 'desktop' && hub.isOnline(d.deviceId));
      if (!desk) return json(res, 503, { error: 'No online desktop' });
      const taskId = `task-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e4)}`;
      const send = (event: string, extra: Record<string, unknown> = {}) => {
        hub.broadcast({
          t: 'task-event',
          event,
          node: 'desktop',
          task: { id: taskId, description: message, ...extra },
        });
      };
      console.log(`[hub] chat: "${message}" → ${taskId}`);
      setTimeout(() => send('task:created', { status: 'pending' }), 250);
      setTimeout(() => send('task:started', { status: 'executing' }), 900);
      setTimeout(
        () => send('task:progress', { status: 'executing', progress: 0.5, completedStepCount: 1, totalSteps: 2 }),
        1900,
      );
      setTimeout(() => {
        send('task:completed', {
          status: 'completed',
          progress: 1,
          completedStepCount: 2,
          totalSteps: 2,
          result: `Done with "${message}"`,
        });
      }, 2900);
      return json(res, 200, {
        dispatch: { taskId, target: 'auto' },
        reply: `I'm on it — task ${taskId} running on the desktop.`,
      });
    }
    if (req.method === 'GET' && url.pathname === '/api/health') {
      return json(res, 200, { ok: true, hubPort: HUB_PORT });
    }
    return json(res, 404, { error: 'Not found' });
  });

  // ── The real DeviceHub ──
  const hub = new DeviceHub({ registry, port: HUB_PORT });
  hub.start();
  server.listen(REST_PORT, () => {
    console.log(`[harness] REST on :${REST_PORT}, hub WS on :${HUB_PORT}`);
  });

  // ── Mock desktop agent: a REAL DeviceClient that answers task relays ──
  const desktop = new DeviceClient({
    url: `ws://localhost:${HUB_PORT}/device-ws`,
    token: desktopReg.token,
    name: 'Test Desktop',
    role: 'desktop',
    capabilities: ['desktop-control', 'agent'],
    onStatus: (ok) => console.log(`[agent] desktop ${ok ? 'connected' : 'disconnected'}`),
    onMessage: (from, msg) => {
      if (msg.t === 'task' && typeof msg.description === 'string') {
        const description = msg.description;
        const taskId = `task-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e4)}`;
        const send = (event: string, extra: Record<string, unknown> = {}) => {
          hub.send(from, {
            t: 'task-event',
            event,
            node: 'desktop',
            task: { id: taskId, description, ...extra },
          });
        };
        console.log(`[agent] task received: "${description}" → ${taskId}`);
        // Full lifecycle, exactly like TaskSyncBridge emits.
        setTimeout(() => send('task:created', { status: 'pending' }), 250);
        setTimeout(() => send('task:started', { status: 'executing' }), 900);
        setTimeout(
          () => send('task:progress', { status: 'executing', progress: 0.5, completedStepCount: 1, totalSteps: 2 }),
          1900,
        );
        setTimeout(() => {
          send('task:completed', {
            status: 'completed',
            progress: 1,
            completedStepCount: 2,
            totalSteps: 2,
            result: `Done with "${description}"`,
          });
          console.log(`[agent] task ${taskId} completed`);
        }, 2900);
      }
    },
  });
  desktop.start();

  console.log('[harness] ready — pair the phone via POST /api/devices/invite then /api/devices/join');
}

main().catch((err) => {
  console.error('[harness] fatal:', err);
  process.exit(1);
});
