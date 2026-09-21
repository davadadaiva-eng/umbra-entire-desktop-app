const path = require('path');
const os = require('os');
const fs = require('fs');

const umbra = 'C:\\Users\\User1\\.claude\\Nuova cartella\\davide\\umbra';
const { ConsentGate } = require(path.join(umbra, 'dist', 'core', 'agent', 'ConsentGate.js'));
const { Desktop2Environment } = require(path.join(umbra, 'dist', 'core', 'desktop2', 'Desktop2Environment.js'));
const { PrivacyGuard } = require(path.join(umbra, 'dist', 'core', 'privacy', 'PrivacyGuard.js'));
const { AuditVault } = require(path.join(umbra, 'dist', 'core', 'vault', 'AuditVault.js'));

const mode = process.argv[2] || 'deny';
const dataDir = path.join(os.tmpdir(), 'consent-test-' + Date.now());
fs.mkdirSync(path.join(dataDir, 'vault'), { recursive: true });

function fail(msg) { console.log('FAIL: ' + msg); process.exit(1); }
function pass(msg) { console.log('PASS: ' + msg); }

async function run() {
  const consent = new ConsentGate({ dataDir, promptTimeoutMs: 2000, askOncePerSession: false });
  const vault = new AuditVault(path.join(dataDir, 'vault'));
  vault.initialize();
  const d2 = new Desktop2Environment({}, {}, new PrivacyGuard(), vault, {
    width: 1280, height: 720, fps: 5, browserPath: '', dataDir, browserPort: 9222,
  }, consent);

  if (mode === 'stop') {
    consent.armEmergencyStop();
    try {
      await d2.executeAction('wait', { ms: 8000 });
      fail('wait should have been blocked by emergency stop');
    } catch (e) {
      if (!/Emergency stop/.test(String(e.message))) fail('unexpected error: ' + e.message);
      pass('emergency stop blocks actions');
    }
    consent.disarmEmergencyStop();
    process.exit(0);
  }

  if (mode === 'grant') {
    try {
      await d2.executeAction('click', { x: 100, y: 100 });
      fail('click should have thrown after grant (browser not running)');
    } catch (e) {
      if (/Consent denied/.test(String(e.message))) fail('consent was denied but expected grant: ' + e.message);
      if (!/not running/.test(String(e.message))) fail('unexpected error: ' + e.message);
      pass('granted action passes gate and reaches browser layer');
    }
    const st = consent.getState();
    if (!st.granted) fail('getState().granted should be true');
    pass('consent state exposed via getState()');
    process.exit(0);
  }

  try {
    await d2.executeAction('click', { x: 100, y: 100 });
    fail('click should have been blocked by consent denial');
  } catch (e) {
    if (!/Consent denied/.test(String(e.message))) fail('unexpected error: ' + e.message);
    pass('denied action blocked by consent gate');
  }
  process.exit(0);
}

run().catch(e => fail(e.message));
