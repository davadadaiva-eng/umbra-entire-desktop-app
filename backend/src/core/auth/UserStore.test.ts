import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { UserStore } from './UserStore';

let store: UserStore;
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'umbra-userstore-'));
const dbPath = path.join(testDir, 'test.db');

beforeAll(() => { store = new UserStore(dbPath); });
afterAll(() => { store.close(); fs.rmSync(testDir, { recursive: true, force: true }); });

describe('UserStore', () => {
  describe('signup + login', () => {
    it('creates a user and returns it', () => {
      const user = store.signup('test@example.com', 'password123', 'Test User');
      expect(user).not.toBeNull();
      expect(user!.email).toBe('test@example.com');
      expect(user!.name).toBe('Test User');
      expect(user!.plan).toBe('free');
      expect(user!.apiKey).toMatch(/^umbra_/);
    });

    it('rejects duplicate email', () => {
      const dup = store.signup('test@example.com', 'other', 'Dup');
      expect(dup).toBeNull();
    });

    it('logs in with correct password', () => {
      const user = store.login('test@example.com', 'password123');
      expect(user).not.toBeNull();
      expect(user!.email).toBe('test@example.com');
    });

    it('rejects wrong password', () => {
      const user = store.login('test@example.com', 'wrong');
      expect(user).toBeNull();
    });

    it('logs in with API key', () => {
      const original = store.signup('key@example.com', 'pass', 'Key User')!;
      const found = store.loginWithApiKey(original.apiKey);
      expect(found).not.toBeNull();
      expect(found!.id).toBe(original.id);
    });

    it('rejects invalid API key', () => {
      expect(store.loginWithApiKey('umbra_bogus')).toBeNull();
    });
  });

  describe('plans', () => {
    it('defaults to free', () => {
      const user = store.signup('plan@example.com', 'pass', 'Plan')!;
      const plan = store.getPlan(user.id);
      expect(plan.tier).toBe('free');
      expect(plan.maxDevices).toBe(0);
      expect(plan.cloudAccess).toBe(false);
    });

    it('sets plan to pro', () => {
      const user = store.signup('pro@example.com', 'pass', 'Pro')!;
      expect(store.setPlan(user.id, 'pro')).toBe(true);
      const plan = store.getPlan(user.id);
      expect(plan.tier).toBe('pro');
      expect(plan.monthlyBudget).toBe(5);
      expect(plan.maxDevices).toBe(1);
    });

    it('advanced is a valid alias with same limits as ultimate', () => {
      const user = store.signup('adv@example.com', 'pass', 'Adv')!;
      store.setPlan(user.id, 'advanced');
      const plan = store.getPlan(user.id);
      // 'advanced' is stored as-is (PLANS has both 'advanced' and 'ultimate')
      expect(['advanced', 'ultimate']).toContain(plan.tier);
      expect(plan.maxDevices).toBe(5);
    });

    it('rejects unknown tier', () => {
      const user = store.signup('bad@example.com', 'pass', 'Bad')!;
      expect(store.setPlan(user.id, 'galaxy')).toBe(false);
    });
  });

  describe('wallet', () => {
    it('init wallet sets budget', () => {
      const user = store.signup('wallet@example.com', 'pass', 'Wallet')!;
      store.initWallet(user.id, 'pro', 5.0);
      expect(store.getWallet(user.id)).toBe(5.0);
    });

    it('deductWallet reduces balance', () => {
      const user = store.signup('deduct@example.com', 'pass', 'Deduct')!;
      store.initWallet(user.id, 'pro', 5.0);
      const remaining = store.deductWallet(user.id, 1.5);
      expect(remaining).toBeCloseTo(3.5);
      expect(store.getWallet(user.id)).toBeCloseTo(3.5);
    });

    it('deductWallet caps at 0', () => {
      const user = store.signup('cap@example.com', 'pass', 'Cap')!;
      store.initWallet(user.id, 'pro', 2.0);
      const remaining = store.deductWallet(user.id, 10.0);
      expect(remaining).toBe(0);
      expect(store.isWalletDepleted(user.id)).toBe(true);
    });
  });

  describe('hetzner server linkage', () => {
    it('stores and retrieves server id', () => {
      const user = store.signup('server@example.com', 'pass', 'Server')!;
      store.setHetznerServerId(user.id, 12345);
      expect(store.getHetznerServerId(user.id)).toBe(12345);
    });

    it('finds user by hetzner server id', () => {
      const user = store.signup('findsrv@example.com', 'pass', 'FindSrv')!;
      store.setHetznerServerId(user.id, 99999);
      const found = store.findByHetznerServerId(99999);
      expect(found).not.toBeNull();
      expect(found!.id).toBe(user.id);
    });
  });

  describe('stripe linkage', () => {
    it('links stripe customer', () => {
      const user = store.signup('stripe@example.com', 'pass', 'Stripe')!;
      store.linkStripeCustomer(user.id, 'cus_123', 'sub_456');
      const found = store.findByStripeCustomerId('cus_123');
      expect(found).not.toBeNull();
      expect(found!.id).toBe(user.id);
    });
  });

  describe('devices', () => {
    it('pairs a device within plan limits', () => {
      const user = store.signup('dev@example.com', 'pass', 'Dev')!;
      store.setPlan(user.id, 'pro'); // maxDevices: 1, mobileApp: true
      const device = store.pairDevice(user.id, 'My Phone', 'phone');
      expect(device).not.toBeNull();
      expect(device!.name).toBe('My Phone');
      expect(device!.type).toBe('phone');
    });

    it('blocks device beyond plan limit', () => {
      const user = store.signup('limit@example.com', 'pass', 'Limit')!;
      store.setPlan(user.id, 'pro'); // maxDevices: 1
      store.pairDevice(user.id, 'Phone 1', 'phone');
      const second = store.pairDevice(user.id, 'Phone 2', 'phone');
      expect(second).toBeNull();
    });

    it('allows unlimited devices on ultimate', () => {
      const user = store.signup('unlim@example.com', 'pass', 'Unlim')!;
      store.setPlan(user.id, 'ultimate');
      store.pairDevice(user.id, 'Phone 1', 'phone');
      store.pairDevice(user.id, 'Phone 2', 'phone');
      const third = store.pairDevice(user.id, 'Phone 3', 'phone');
      expect(third).not.toBeNull();
    });

    it('removes a device', () => {
      const user = store.signup('rmdev@example.com', 'pass', 'RmDev')!;
      store.setPlan(user.id, 'pro');
      const device = store.pairDevice(user.id, 'Temp', 'phone')!;
      expect(store.removeDevice(user.id, device.id)).toBe(true);
      expect(store.listDevices(user.id)).toHaveLength(0);
    });

    it('lists devices', () => {
      const user = store.signup('listdev@example.com', 'pass', 'ListDev')!;
      store.setPlan(user.id, 'pro');
      store.pairDevice(user.id, 'A', 'phone');
      store.pairDevice(user.id, 'B', 'phone'); // pro maxDevices=1, second fails
      expect(store.listDevices(user.id)).toHaveLength(1);
    });
  });

  describe('getUserWithJIT', () => {
    it('returns jit fields', () => {
      const user = store.signup('jit@example.com', 'pass', 'Jit')!;
      store.initWallet(user.id, 'pro', 5.0);
      store.setHetznerServerId(user.id, 77777);
      const jit = store.getUserWithJIT(user.id);
      expect(jit).not.toBeNull();
      expect(jit!.ai_budget_limit).toBe(5.0);
      expect(jit!.hetzner_server_id).toBe(77777);
    });
  });
});
