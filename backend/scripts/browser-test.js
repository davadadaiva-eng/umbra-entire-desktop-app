const path = require('path');
const { VirtualDisplayManager } = require('C:/Users/User1/.claude/Nuova cartella/davide/umbra/dist/core/workspace/VirtualDisplayManager.js');
const { InputGuard } = require('C:/Users/User1/.claude/Nuova cartella/davide/umbra/dist/core/workspace/InputGuard.js');
const { PrivacyGuard } = require('C:/Users/User1/.claude/Nuova cartella/davide/umbra/dist/core/privacy/PrivacyGuard.js');
const { AuditVault } = require('C:/Users/User1/.claude/Nuova cartella/davide/umbra/dist/core/vault/AuditVault.js');
const { Desktop2Environment } = require('C:/Users/User1/.claude/Nuova cartella/davide/umbra/dist/core/desktop2/Desktop2Environment.js');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const fs = require('fs');

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

  console.log('1. starting desktop2...');
  await desktop2.start();

  console.log('2. launching browser...');
  await desktop2.launchBrowser('https://example.com');
  await sleep(3000);

  console.log('3. page info...');
  console.log('   ', await desktop2.getPageInfo());

  console.log('4. screenshot...');
  const shot = await desktop2.screenshot();
  if (shot) { fs.writeFileSync(path.join(process.env.USERPROFILE, '.umbra', 'tmp', 'desktop2-test.png'), shot); console.log('   saved', shot.length, 'bytes'); }

  console.log('5. accessibility snapshot...');
  const snap = await desktop2.getAccessibilitySnapshot();
  console.log('   length:', snap ? snap.length : 0, snap ? snap.substring(0, 400).replace(/\n/g, ' | ') : '');

  console.log('6. evaluating JS...');
  console.log('   ', await desktop2.evaluate('document.title'));

  console.log('7. navigate + click + type...');
  await desktop2.navigate('https://www.google.com');
  await sleep(3000);
  const typed = await desktop2.typeIntoSelector('textarea[name="q"]', 'umbra os');
  console.log('   typed into search box:', typed);
  await sleep(500);
  await desktop2.pressKey('Enter');
  await sleep(3000);
  console.log('   after search:', await desktop2.getPageInfo());

  console.log('8. tabs...');
  console.log('   ', await desktop2.listTabs());

  console.log('9. state...');
  console.log('   ', desktop2.getState());

  console.log('10. closing browser...');
  await desktop2.closeBrowser();
  console.log('A3 BROWSER TEST PASSED');
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
