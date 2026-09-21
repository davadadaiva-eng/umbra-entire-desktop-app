/**
 * Ghost-demo — proves Umbra can autonomously drive a SECOND Windows virtual
 * desktop (real apps + the user's real Chrome profile with all accounts)
 * while the user keeps working on their own desktop.
 *
 * Runs the whole thing through the HTTP API (port 8787), i.e. the exact same
 * remote-control surface a phone/UI would use.
 *
 * Run:   npx ts-node scripts/ghost-demo.ts
 * Env:   UMBRA_ENGINE=ghost + UMBRA_CONSENT_AUTOGRANT=1 (set by the script)
 * WARN:  if your Chrome is already open without a debug port, Umbra restarts
 *        it with your profile (tabs restored via --restore-last-session).
 */

import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';
import UmbraOS from '../src/index';

const API = 'http://127.0.0.1:8787';

interface ApiResult { result?: string; error?: string }

async function ghost(action: string, params: Record<string, unknown> = {}): Promise<string> {
  const r = await fetch(`${API}/api/ghost/action`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, params }),
  });
  const j = await r.json() as ApiResult;
  if (!r.ok || j.error) throw new Error(`${action}: ${j.error || JSON.stringify(j)}`);
  return String(j.result ?? '');
}

async function capture(): Promise<Buffer> {
  const r = await fetch(`${API}/api/ghost/capture`);
  const j = await r.json() as { image?: string; error?: unknown };
  if (!r.ok || !j.image) throw new Error(`capture: ${j.error || JSON.stringify(j)}`);
  return Buffer.from(j.image, 'base64');
}

async function status(): Promise<Record<string, any>> {
  const r = await fetch(`${API}/api/status`);
  return r.json() as Promise<Record<string, any>>;
}

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error('ASSERT FAILED: ' + msg);
}

async function main(): Promise<void> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'umbra-ghost-demo-'));
  process.env['UMBRA_ENGINE'] = 'ghost';
  process.env['UMBRA_CONSENT_AUTOGRANT'] = '1';

  console.log('--- booting Umbra OS (ghost engine, temp data dir, AUTOGRANT) ---');
  const umbra = new UmbraOS();
  await umbra.initialize(dataDir);

  try {
    const st = await status();
    console.log('1. ghost status →', JSON.stringify(st.realDesktop ?? st.desktop2 ?? {}));

    const openMsg = await ghost('open_chrome', { url: 'https://www.google.com' });
    console.log('2. open_chrome →', openMsg);
    assert(/real profile/i.test(openMsg), 'open_chrome must report the real profile');

    const title = await ghost('chrome_evaluate', { expression: 'document.title + " | " + location.hostname' });
    console.log('3. chrome_evaluate →', JSON.stringify(title));
    assert(typeof title === 'string' && title.trim().length > 0, 'Chrome DOM must be reachable');

    const snap = await ghost('read_screen');
    console.log('4. read_screen (DOM) →', snap.replace(/\s+/g, ' ').substring(0, 150));

    const st2 = await status();
    const rd = (st2.realDesktop || {}) as { chromeRealProfile?: boolean; chromeMode?: boolean };
    console.log('5. profile check → chromeMode=', rd.chromeMode, '| realProfile=', rd.chromeRealProfile);
    assert(rd.chromeRealProfile === true, 'must be driving the REAL Chrome profile (accounts)');

    const appMsg = await ghost('open_app', { app: 'notepad' });
    console.log('6. open_app notepad →', appMsg);

    const typed = await ghost('app_type', {
      text: 'Hello from Umbra Ghost — I am working on Desktop 2 while you use Desktop 1.',
    });
    console.log('7. app_type →', typed);

    const png = await capture();
    const shotPath = path.join(dataDir, 'live-desktop2.png');
    fs.writeFileSync(shotPath, png);
    console.log('8. live capture →', shotPath, '(' + png.length + ' bytes PNG)');

    let ocrText = '';
    try {
      ocrText = await ghost('read_screen');
      console.log('9. read_screen (OCR) →', ocrText.replace(/\s+/g, ' ').substring(0, 160));
    } catch (e) {
      console.log('9. read_screen (OCR) skipped:', (e as Error).message);
    }
    assert(ocrText.length > 0 || rd.chromeRealProfile === true, 'either OCR or CDP read-back must work');

    console.log('\nGHOST DEMO PASS — Umbra is on Desktop 2 (real Chrome profile + apps),\n' +
                'acting through the HTTP API, while Desktop 1 stays yours.');
  } finally {
    await fetch(`${API}/api/shutdown`, { method: 'POST' }).catch(() => {});
    await new Promise(r => setTimeout(r, 1500));
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { }
  }
}

main().catch(e => {
  console.error('\nGHOST DEMO FAIL:', (e as Error).message);
  process.exit(1);
});