import {
  MCP_CATALOG,
  VERIFIED_CONNECTORS,
  TEMPLATE_CONNECTORS,
  findCatalogEntry,
  catalogByCategory,
  McpCatalogEntry,
} from './McpCatalog';

describe('MCP Connector Catalog', () => {
  it('ships a mega catalog (≥1000 connectors)', () => {
    expect(MCP_CATALOG.length).toBeGreaterThanOrEqual(1000);
  });

  it('defines at least 300 verified connectors and 200 templates', () => {
    expect(VERIFIED_CONNECTORS.length).toBeGreaterThanOrEqual(300);
    expect(TEMPLATE_CONNECTORS.length).toBeGreaterThanOrEqual(200);
  });

  it('has unique ids across the catalog', () => {
    const ids = MCP_CATALOG.map(c => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('has valid auth types and required fields on every entry', () => {
    const auth = new Set(['none', 'bearer', 'apiKey', 'oauth']);
    for (const c of MCP_CATALOG) {
      expect(auth.has(c.authType)).toBe(true);
      expect(c.name).toBeTruthy();
      expect(c.category).toBeTruthy();
      expect(c.description).toBeTruthy();
      expect(c.kind).toMatch(/^(verified|template)$/);
      expect(c.enabled).toBe(false);
    }
  });

  it('renders slack and stripe as verified, deployable connectors', () => {
    const slack = findCatalogEntry('communication-slack');
    const stripe = findCatalogEntry('payments-finance-stripe');
    expect(slack?.kind).toBe('verified');
    expect(slack?.authType).toBe('bearer');
    expect(stripe?.kind).toBe('verified');
    expect(stripe?.baseUrl).toBeFalsy();
  });

  it('keeps PDF-referenced connectors as templates awaiting endpoints', () => {
    const f24 = findCatalogEntry('payments-finance-f24-tax-calculator');
    const priorArt = findCatalogEntry('business-legal-prior-art-search');
    expect(f24?.kind).toBe('template');
    expect(priorArt?.kind).toBe('template');
    expect(f24?.baseUrl).toBe('');
  });

  it('groups every connector into exactly one category', () => {
    const grouped = catalogByCategory();
    const total = Object.values(grouped).reduce((n, list) => n + list.length, 0);
    expect(total).toBe(MCP_CATALOG.length);
    expect(Object.keys(grouped).length).toBeGreaterThanOrEqual(20);
  });

  it('assigns ids unique per category', () => {
    const grouped = catalogByCategory();
    for (const list of Object.values(grouped)) {
      const ids = list.map((c: McpCatalogEntry) => c.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });
});