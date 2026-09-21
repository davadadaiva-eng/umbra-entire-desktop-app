const { spawnSync } = require('child_process');
const I = require('C:/Users/User1/.claude/Nuova cartella/davide/umbra/dist/native/win32/InputNative.js');

const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  spawnSync('powershell.exe', ['-NoProfile', '-Command', 'Get-Process notepad -ErrorAction SilentlyContinue | Stop-Process -Force']);
  await sleep(600);

  console.log('1. launching notepad...');
  if (!I.launchApp('notepad.exe')) { console.log('FAIL: launch'); process.exit(1); }
  await sleep(3000);

  console.log('2. focus notepad...');
  if (!I.focusWindow('notepad')) { console.log('FAIL: focus'); process.exit(1); }
  await sleep(500);
  const rect = I.getWindowRect('notepad');
  if (!rect) { console.log('FAIL: rect'); process.exit(1); }
  console.log('   rect:', rect);

  console.log('3. click into text area...');
  I.sendClick(rect.x + Math.round(rect.width / 2), rect.y + Math.round(rect.height * 0.45), 0);
  await sleep(800);

  console.log('4. typing two lines...');
  I.typeText('hello from umbra');
  await sleep(300);
  I.sendKey('Enter');
  await sleep(300);
  I.typeText('second line works too');
  await sleep(1000);

  console.log('5. UIA verify...');
  const r = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'C:/Users/User1/AppData/Local/Temp/opencode/read-notepad.ps1'], { encoding: 'utf8', timeout: 30000 });
  const out = r.stdout.trim();
  console.log(out.split('\n').filter(l => l.startsWith('TAIL') || l.startsWith('TEXT')).join('\n'));
  const hasL1 = out.includes('hello from umbra');
  const hasL2 = out.includes('second line works too');
  console.log(hasL1 && hasL2 ? 'INPUT TEST PASSED' : 'INPUT TEST FAILED');
  process.exit(hasL1 && hasL2 ? 0 : 1);
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
