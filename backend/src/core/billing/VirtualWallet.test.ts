import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { UserStore } from '../auth/UserStore';
import { VirtualWallet } from './VirtualWallet';

let store: UserStore;
let wallet: VirtualWallet;
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'umbra-wallet-'));

beforeAll(() => {
  store = new UserStore(path.join(testDir, 'users.db'));
  wallet = new VirtualWallet(store);
});
afterAll(() => { store.close(); fs.rmSync(testDir, { recursive: true, force: true }); });

describe('VirtualWallet', () => {
  it('initializes wallet with correct budget for pro', () => {
    const user = store.signup('pro-wallet@test.com', 'pass', 'Pro')!;
    wallet.init(user.id, 'pro');
    expect(wallet.balance(user.id)).toBe(5.0);
  });

  it('initializes wallet with correct budget for ultimate', () => {
    const user = store.signup('ult-wallet@test.com', 'pass', 'Ult')!;
    wallet.init(user.id, 'ultimate');
    expect(wallet.balance(user.id)).toBe(10.0);
  });

  it('initializes wallet with correct budget for enterprise', () => {
    const user = store.signup('ent-wallet@test.com', 'pass', 'Ent')!;
    wallet.init(user.id, 'enterprise');
    expect(wallet.balance(user.id)).toBe(20.0);
  });

  it('returns correct budget breakdowns per tier', () => {
    expect(wallet.getBudgets('pro')).toEqual({ models: 5, cloud: 6, telco: 0 });
    expect(wallet.getBudgets('ultimate')).toEqual({ models: 10, cloud: 8, telco: 0 });
    expect(wallet.getBudgets('advanced')).toEqual({ models: 10, cloud: 8, telco: 0 });
    expect(wallet.getBudgets('enterprise')).toEqual({ models: 20, cloud: 25, telco: 15 });
    expect(wallet.getBudgets('free')).toEqual({ models: 0, cloud: 0, telco: 0 });
  });

  it('deducts cost and returns remaining', () => {
    const user = store.signup('deduct-wallet@test.com', 'pass', 'Deduct')!;
    wallet.init(user.id, 'pro');
    const remaining = wallet.deduct(user.id, 1.23);
    expect(remaining).toBeCloseTo(3.77);
  });

  it('reports depleted when balance hits 0', () => {
    const user = store.signup('depleted@test.com', 'pass', 'Depleted')!;
    wallet.init(user.id, 'pro');
    wallet.deduct(user.id, 5.0);
    expect(wallet.depleted(user.id)).toBe(true);
    expect(wallet.balance(user.id)).toBe(0);
  });

  it('links hetzner server', () => {
    const user = store.signup('srv-wallet@test.com', 'pass', 'Srv')!;
    wallet.linkServer(user.id, 42);
    expect(store.getHetznerServerId(user.id)).toBe(42);
  });

  it('links stripe customer', () => {
    const user = store.signup('stripe-wallet@test.com', 'pass', 'Stripe')!;
    wallet.linkStripe(user.id, 'cus_test', 'sub_test');
    const found = store.findByStripeCustomerId('cus_test');
    expect(found).not.toBeNull();
  });
});
