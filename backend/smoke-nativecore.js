const m = require('./src/native/win32/NativeCore.ts');

(async () => {
  const mon = await m.enumerateMonitors();
  console.log('MONITORS:', JSON.stringify(mon));
  const cur = await m.getCursorPos();
  console.log('CURSOR:', JSON.stringify(cur));
  console.log('ESC down?', await m.isEscapePressed());

  console.log('create stealth:', await m.createStealthDesktop('UmbraStealthSmoke'));
  console.log('exists (held):', await m.desktopExists('UmbraStealthSmoke'));

  const pid = await m.launchInDesktop('UmbraStealthSmoke', 'C:\\Windows\\System32\\notepad.exe');
  console.log('launch notepad pid:', pid);

  await new Promise(r => setTimeout(r, 800));
  const hwnd = await m.findWindow('Untitled - Notepad');
  console.log('find notepad hwnd:', hwnd);
  if (hwnd) {
    console.log('alive:', await m.isWindowAlive(hwnd));
    console.log('postChar A:', await m.postChar(hwnd, 'A'));
    console.log('postKey ESC:', await m.postKey(hwnd, 27, false));
  }

  console.log('destroy stealth:', await m.destroyStealthDesktop('UmbraStealthSmoke'));
  console.log('exists (after):', await m.desktopExists('UmbraStealthSmoke'));
  await m.stop();
  console.log('DAEMON STOPPED');
  process.exit(0);
})().catch(e => { console.error('ERR', e); process.exit(1); });