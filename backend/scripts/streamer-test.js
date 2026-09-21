const path = require('path');
const fs = require('fs');
const WebSocket = require('ws');
const { VirtualDisplayManager } = require('C:/Users/User1/.claude/Nuova cartella/davide/umbra/dist/core/workspace/VirtualDisplayManager.js');
const { InputGuard } = require('C:/Users/User1/.claude/Nuova cartella/davide/umbra/dist/core/workspace/InputGuard.js');
const { PrivacyGuard } = require('C:/Users/User1/.claude/Nuova cartella/davide/umbra/dist/core/privacy/PrivacyGuard.js');
const { AuditVault } = require('C:/Users/User1/.claude/Nuova cartella/davide/umbra/dist/core/vault/AuditVault.js');
const { Desktop2Environment } = require('C:/Users/User1/.claude/Nuova cartella/davide/umbra/dist/core/desktop2/Desktop2Environment.js');
const { PreviewStreamer } = require('C:/Users/User1/.claude/Nuova cartella/davide/umbra/dist/mobile/PreviewStreamer.js');

const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const dataDir = path.join(process.env.USERPROFILE, '.umbra');
  const displayManager = new VirtualDisplayManager({ maxDisplays: 2, displayWidth: 1920, displayHeight: 1080, displayFps: 30 });
  const inputGuard = new InputGuard();
  const privacy = new PrivacyGuard();
  const vault = new AuditVault(path.join(dataDir, 'vault'));
  vault.initialize();
  const desktop2 = new Desktop2Environment(displayManager, inputGuard, privacy, vault, {
    width: 1920, height: 1080, fps: 30,
    browserPath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    dataDir,
  });

  const streamer = new PreviewStreamer({ enabled: true, port: 9090, fps: 2 });
  streamer.setFrameProvider(() => desktop2.screenshot());
  streamer.setCommandHandler((action, params) => desktop2.executeAction(action, params));

  await desktop2.start();
  await desktop2.launchBrowser('https://example.com');
  await sleep(2000);
  streamer.start();

  const ws = new WebSocket('ws://127.0.0.1:9090');
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });

  let frames = 0;
  let gotResult = null;
  let gotError = null;
  let gotPong = false;

  ws.on('message', raw => {
    const msg = JSON.parse(raw.toString());
    if (msg.type === 'frame') { frames++; if (frames === 1) fs.writeFileSync(path.join(dataDir, 'tmp', 'stream-frame.png'), Buffer.from(msg.image, 'base64')); }
    if (msg.type === 'result') gotResult = msg.result;
    if (msg.type === 'error') gotError = msg.error;
    if (msg.type === 'pong') gotPong = true;
  });

  ws.send(JSON.stringify({ type: 'subscribe' }));
  await sleep(4000);
  ws.send(JSON.stringify({ type: 'command', action: 'getInfo', params: {} }));
  await sleep(1000);
  ws.send(JSON.stringify({ type: 'ping' }));
  await sleep(800);

  console.log('frames received:', frames, '(expect >= 6)');
  console.log('command result:', gotResult);
  console.log('command error:', gotError || 'none');
  console.log('pong:', gotPong);
  const ok = frames >= 4 && gotResult && !gotError && gotPong;
  console.log(ok ? 'STREAMER TEST PASSED' : 'STREAMER TEST FAILED');

  ws.close();
  streamer.stop();
  await desktop2.closeBrowser();
  process.exit(ok ? 0 : 1);
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
