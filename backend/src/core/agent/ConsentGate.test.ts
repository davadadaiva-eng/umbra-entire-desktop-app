import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ConsentGate } from './ConsentGate';

describe('ConsentGate', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'consent-test-'));
  });

  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  test('emergency stop arm/disarm/check lifecycle', async () => {
    const gate = new ConsentGate({ dataDir });
    expect(gate.isEmergencyStopArmed()).toBe(false);
    expect(await gate.checkEmergencyStop()).toBe(false);

    gate.armEmergencyStop();
    expect(gate.isEmergencyStopArmed()).toBe(true);
    expect(await gate.checkEmergencyStop()).toBe(true);
    expect(fs.existsSync(path.join(dataDir, 'emergency-stop'))).toBe(true);

    gate.disarmEmergencyStop();
    expect(gate.isEmergencyStopArmed()).toBe(false);
    expect(await gate.checkEmergencyStop()).toBe(false);
  });

  test('request auto-denies on timeout without user input', async () => {
    const gate = new ConsentGate({ dataDir, promptTimeoutMs: 100, askOncePerSession: false, autoApprove: false });
    const result = await gate.request('test reason');
    expect(result).toBe('denied');
    expect(gate.getState().denied).toBe(true);
  });

  test('session grant is remembered with askOncePerSession', async () => {
    const gate = new ConsentGate({ dataDir, promptTimeoutMs: 100, askOncePerSession: true });

    gate['granted'] = true;
    const result = await gate.request('second call');
    expect(result).toBe('granted');
  });

  test('reset clears grant state', () => {
    const gate = new ConsentGate({ dataDir });
    gate['granted'] = true;
    gate['denied'] = false;
    gate.reset();
    expect(gate.isGranted()).toBe(false);
    expect(gate.getState().granted).toBe(false);
  });

  test('getState exposes askOncePerSession', () => {
    const gate = new ConsentGate({ dataDir, askOncePerSession: false });
    expect(gate.getState().askOncePerSession).toBe(false);
  });

  test('propose with the same idempotencyKey returns the existing proposal', async () => {
    const gate = new ConsentGate({ dataDir });
    const a = await gate.proposeAction('t-1', 'delete-file', { path: 'a.txt' }, 'key-1');
    const b = await gate.proposeAction('t-1', 'delete-file', { path: 'a.txt' }, 'key-1');
    expect(b.id).toBe(a.id);
  });

  test('propose without a key creates distinct proposals', async () => {
    const gate = new ConsentGate({ dataDir });
    const a = await gate.proposeAction('t-1', 'noop', {});
    const b = await gate.proposeAction('t-1', 'noop', {});
    expect(b.id).not.toBe(a.id);
  });

  test('reviewing an already-decided proposal is a no-op', async () => {
    const gate = new ConsentGate({ dataDir });
    const proposal = await gate.proposeAction('t-1', 'noop', {});
    const first = await gate.reviewAction(proposal.id, { approved: true, hash: proposal.hash });
    expect(first.success).toBe(true);
    const second = await gate.reviewAction(proposal.id, { approved: false, hash: proposal.hash });
    expect(second.success).toBe(false);
    expect(second.error).toMatch(/already approved/);
    const stored = await gate.getProposal(proposal.id);
    expect(stored?.status).toBe('approved');
  });
});
