/**
 * Serve Umbra OS headless and stay alive until SIGINT — used to exercise the
 * live API/MCP endpoints from another process (e.g. `hermes mcp test umbra`).
 *
 *   npx ts-node scripts/serve-headless.ts
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { UmbraOS } from '../src/index';

const dir = process.env['UMBRA_DATA_DIR'] || fs.mkdtempSync(path.join(os.tmpdir(), 'umbra-serve-'));
process.env.UMBRA_HEADLESS = '1';
process.env.UMBRA_ROLE = 'cloud';

const umbra = new UmbraOS();

async function main() {
  await umbra.initialize(dir);
  console.log('SERVE_READY dataDir=' + dir);
}

main().catch(err => {
  console.error('SERVE_FAIL', err);
  process.exit(1);
});

process.on('SIGINT', async () => {
  await umbra.shutdown().catch(() => {});
  process.exit(0);
});
process.on('SIGTERM', async () => {
  await umbra.shutdown().catch(() => {});
  process.exit(0);
});
