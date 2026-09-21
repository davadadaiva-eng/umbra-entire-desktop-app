import { CompanionRegistry, DEFAULT_COMPANIONS } from './CompanionRegistry';

describe('CompanionRegistry', () => {
  it('ships a default team of named, specialized companions', () => {
    const ids = DEFAULT_COMPANIONS.map(c => c.id);
    expect(ids).toContain('assistant');
    expect(ids).toContain('research');
    expect(ids).toContain('creative');
    expect(ids).toContain('ops');
    expect(ids).toContain('sales');
    expect(new Set(ids).size).toBe(ids.length);
    expect(DEFAULT_COMPANIONS.every(c => c.skills.length > 0)).toBe(true);
  });

  it('routes research intents to the research companion', () => {
    const reg = new CompanionRegistry();
    expect(reg.best('research the market size for electric bikes and gather sources').id).toBe('research');
  });

  it('routes scheduling intents to the ops companion', () => {
    const reg = new CompanionRegistry();
    expect(reg.best('schedule a meeting with the team next week').id).toBe('ops');
  });

  it('routes copy/ad intents to the creative companion', () => {
    const reg = new CompanionRegistry();
    expect(reg.best('write copy for the launch ad').id).toBe('creative');
  });

  it('routes lead intents to the sales companion', () => {
    const reg = new CompanionRegistry();
    expect(reg.best('score and route this lead').id).toBe('sales');
  });

  it('falls back to the default companion when nothing scores', () => {
    const reg = new CompanionRegistry();
    const route = reg.scoreIntent('rotate the tires and inflate them');
    expect(route.direct).toBe(false);
    expect(route.ranked).toHaveLength(0);
    expect(route.best.id).toBe('assistant');
  });

  it('ranks the winning companion highest and lists the roster', () => {
    const reg = new CompanionRegistry();
    const route = reg.scoreIntent('score and route this lead');
    expect(route.ranked[0].profile.id).toBe('sales');
    expect(reg.list().length).toBe(DEFAULT_COMPANIONS.length);
    expect(reg.byId('research')?.skills).toContain('competitive-intel');
  });
});
