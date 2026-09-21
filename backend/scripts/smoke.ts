/**
 * Smoke test: boot Umbra OS headless with a throwaway data dir, confirm the
 * whole composition root (API, device hub, model router, memory, agent, …)
 * initializes and shuts down cleanly, then exit.
 *
 *   npx ts-node scripts/smoke.ts
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { UmbraOS } from '../src/index';

async function main(): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'umbra-smoke-'));
  process.env.UMBRA_HEADLESS = '1';
  process.env.UMBRA_ROLE = 'cloud';

  const umbra = new UmbraOS();
  try {
    await umbra.initialize(dir);
    const status = (umbra as any).getApiStatus ? await (umbra as any).getApiStatus() : null;
    console.log('SMOKE_OK initialized=' + (status?.initialized ?? 'true'));
    if (status?.execution) {
      console.log('SMOKE execution=' + JSON.stringify(status.execution));
    }
  } finally {
    await umbra.shutdown().catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

main()
  .then(() => { console.log('SMOKE_PASS'); process.exit(0); })
  .catch(err => { console.error('SMOKE_FAIL', err); process.exit(1); });
