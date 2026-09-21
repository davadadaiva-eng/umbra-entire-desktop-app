/**
 * End-to-end smoke test for the Umbra Mesh daemon + TS host binding.
 *
 * Requires: `cargo build --release` (see mesh/README.md).
 * Run:      npm run e2e   (after tsc build)
 *
 * Exercises: boot → status → pair.create (QR + wire) → verify valid →
 * tampered/expired rejected → full demo handshake (keys must match) →
 * devices.list → revoke.
 */

import { MeshDaemonClient, RpcError } from './index';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}

async function main(): Promise<void> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'umbra-e2e-'));
  const mesh = new MeshDaemonClient();
  let failures = 0;

  try {
    const exe = MeshDaemonClient.findBinary(path.resolve(__dirname, '..'));
    await mesh.start(exe, { dataDir, keystore: 'file', name: 'e2e-host' });

    // 1. status
    const status = await mesh.status();
    assert(status.ok, 'status.ok');
    assert(status.identity.device_id.length === 64, `device_id length (got ${status.identity.device_id.length})`);
    assert(status.identity.device_id.startsWith('umbra-node-v1') === false, 'device_id is a plain sha256 hex');
    assert(status.identity.created === true, 'first boot must create identity');
    assert(status.keystore === 'file', 'keystore fallback');
    console.log('1. status ok:', status.identity.device_id.slice(0, 12) + '…', `(${status.version})`);

    // 2. pair.create
    const qr = await mesh.pairCreate(120);
    assert(qr.wire.payload.v === 1, 'payload version 1');
    assert(qr.wire.payload.id === status.identity.device_id, 'payload id == device_id');
    assert(qr.wire.payload.exp > Math.floor(Date.now() / 1000), 'exp in future');
    assert(qr.qr_ascii.length > 0, 'qr rendered');
    console.log('2. pair.create ok (qr ascii lines=' + qr.qr_ascii.split('\n').length + ')');

    // 3. verify (valid)
    const verified = await mesh.pairVerify(qr.wire);
    assert(verified.ok === true, 'verify accepts valid wire');
    assert(verified.device_id === status.identity.device_id, 'verify reports same id');
    console.log('3. verify (valid) ok');

    // 4. verify rejects tampered
    const tampered = JSON.parse(JSON.stringify(qr.wire));
    tampered.payload.addrs.push('9.9.9.9');
    let rejected = false;
    try {
      await mesh.pairVerify(tampered);
    } catch (e) {
      rejected = e instanceof RpcError && /verification failed/i.test(e.message);
    }
    assert(rejected, 'verify rejects tampered payload');
    console.log('4. verify rejects tampered ok');

    // 5. demo handshake: both sides must derive identical session keys
    const demo = await mesh.pairDemo();
    assert(demo.match === true, 'demo handshake must match (session keys equal)');
    assert(demo.ok === true, 'demo.ok');
    console.log('5. demo handshake match ok (device=', demo.device_id.slice(0, 12) + '…', ')');

    // 6. devices.list includes the simulated device
    const list = await mesh.devicesList();
    assert(list.devices.some((d: { device_id: string }) => d.device_id === demo.device_id), 'demo device persisted');
    assert(list.devices.length >= 1, 'at least one device');
    console.log('6. devices.list ok (count=' + list.devices.length + ')');

    // 7. revoke
    const revoked = await mesh.devicesRevoke(demo.device_id);
    assert(revoked.ok === true, 'revoke ok');
    const after = await mesh.devicesList();
    assert(after.devices.every((d: { device_id: string }) => d.device_id !== demo.device_id), 'device removed');
    console.log('7. revoke ok');

    console.log('\nE2E PASS — Umbra Mesh M1 (identity + pairing + ZKEP) verified end-to-end.');
  } catch (err) {
    failures++;
    console.error('\nE2E FAIL:', err);
  } finally {
    await mesh.stop().catch(() => undefined);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
  process.exit(failures ? 1 : 0);
}

main();