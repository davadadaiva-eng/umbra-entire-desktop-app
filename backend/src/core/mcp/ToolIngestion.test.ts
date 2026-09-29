import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { ToolIngestion } from './ToolIngestion';
import { curatedToolCount } from './curatedTools';

function tmpDb(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'umbra-ingest-'));
  return path.join(dir, 'test-connectors.db');
}

const OPENAPI_SPEC = {
  openapi: '3.0.0',
  info: { title: 'Pets', version: '1.0' },
  paths: {
    '/pets': {
      get: {
        operationId: 'listPets',
        summary: 'List all pets',
        parameters: [
          { name: 'limit', in: 'query', schema: { type: 'integer' }, description: 'Max pets' },
        ],
      },
      post: {
        operationId: 'createPet',
        summary: 'Create a pet',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: { name: { type: 'string' }, age: { type: 'integer' } },
                required: ['name'],
              },
            },
          },
        },
      },
    },
    '/pets/{id}': {
      get: {
        operationId: 'getPet',
        summary: 'Get one pet',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      },
    },
  },
};

const REFS_SPEC = {
  openapi: '3.0.4',
  info: { title: 'Refs', version: '1.0' },
  paths: {
    '/pets': {
      post: {
        operationId: 'addPet',
        summary: 'Add a new pet to the store',
        requestBody: {
          required: true,
          content: {
            // Real specs reference shared component schemas.
            'application/json': { schema: { $ref: '#/components/schemas/Pet' } },
          },
        },
      },
    },
    '/users/createWithList': {
      post: {
        operationId: 'createUsersWithListInput',
        summary: 'Creates list of users with given input array',
        requestBody: {
          content: {
            'application/json': {
              schema: { type: 'array', items: { $ref: '#/components/schemas/User' } },
            },
          },
        },
      },
    },
    '/ghosts': {
      post: {
        operationId: 'addGhost',
        summary: 'Body references a schema that does not exist',
        requestBody: {
          content: { 'application/json': { schema: { $ref: '#/components/schemas/Missing' } } },
        },
      },
    },
  },
  components: {
    schemas: {
      Pet: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          photoUrls: { type: 'array', items: { $ref: '#/components/schemas/Tag' } },
        },
        required: ['name'],
      },
      Tag: { type: 'object', properties: { id: { type: 'integer' } } },
      User: { type: 'object', properties: { username: { type: 'string' } }, required: ['username'] },
    },
  },
};

describe('ToolIngestion', () => {
  let dbPath: string;
  let ingestion: ToolIngestion;

  beforeEach(() => {
    dbPath = tmpDb();
    ingestion = new ToolIngestion(dbPath);
  });

  afterEach(() => {
    ingestion.close();
  });

  it('loads the curated tool set with real endpoint templates', () => {
    const stored = ingestion.loadCurated();
    expect(stored).toBe(curatedToolCount());
    expect(stored).toBeGreaterThan(20);

    const send = ingestion.get('curated-gmail.send_message');
    expect(send).toBeDefined();
    expect(send!.endpoint_template).toBe('/gmail/v1/users/me/messages/send');
    expect(send!.http_method).toBe('POST');
    expect(send!.parameters_schema.required).toEqual(['to', 'subject', 'body']);
    expect(send!.schema_quality).toBe('curated');
  });

  it('parses OpenAPI specs into flat-arg ToolDefinitions', () => {
    const n = ingestion.ingestOpenApi('test-pets', OPENAPI_SPEC, { baseUrl: 'https://pets.test' });
    expect(n).toBe(3);

    const create = ingestion.get('test-pets.create_pet');
    expect(create).toBeDefined();
    expect(create!.http_method).toBe('POST');
    expect(create!.endpoint_template).toBe('/pets');
    expect(create!.base_url).toBe('https://pets.test');
    expect(create!.parameters_schema.required).toContain('name');
    expect(create!.parameters_schema.properties.name).toBeDefined();

    const getOne = ingestion.get('test-pets.get_pet');
    expect(getOne!.parameters_schema.required).toContain('id');
    expect(getOne!.schema_quality).toBe('openapi');
  });

  it('normalizes $ref request bodies so definitions survive read-back (regression: petstore add_pet)', () => {
    const n = ingestion.ingestOpenApi('ref-pets', REFS_SPEC);
    expect(n).toBe(3);

    // All three definitions must round-trip through sqlite without dropping.
    expect(ingestion.getForConnector('ref-pets').length).toBe(3);

    // Resolved object body is flattened into top-level args (like Petstore).
    const addPet = ingestion.get('ref-pets.add_pet');
    expect(addPet).toBeDefined();
    expect(addPet!.parameters_schema.properties.name?.type).toBe('string');
    expect(addPet!.parameters_schema.required).toContain('name');
    // Nested $ref inside array items is resolved too.
    expect(addPet!.parameters_schema.properties.photoUrls?.items?.type).toBe('object');

    // Array bodies keep a single `body` property with resolved items.
    const listInput = ingestion.get('ref-pets.create_users_with_list_input');
    expect(listInput).toBeDefined();
    expect(listInput!.parameters_schema.properties.body?.type).toBe('array');
    expect(listInput!.parameters_schema.properties.body?.items?.type).toBe('object');

    // Dangling $ref: no crash, shape fallback keeps the tool usable.
    const ghost = ingestion.get('ref-pets.add_ghost');
    expect(ghost).toBeDefined();
    expect(ghost!.parameters_schema.properties.body?.type).toBe('string');
  });

  it('ingests MCP tools/list responses with native JSON Schema', () => {
    const n = ingestion.ingestMcpTools('test-mcp', [
      {
        name: 'get_weather',
        description: 'Get current weather for a city',
        inputSchema: {
          type: 'object',
          properties: { city: { type: 'string', description: 'City name' } },
          required: ['city'],
        },
      },
    ], { credentialService: 'weather' });

    expect(n).toBe(1);
    const def = ingestion.get('test-mcp.get_weather');
    expect(def).toBeDefined();
    expect(def!.transport).toBe('mcp');
    expect(def!.schema_quality).toBe('mcp');
    expect(def!.parameters_schema.required).toEqual(['city']);
  });

  it('roundtrips definitions through sqlite without corruption', () => {
    ingestion.ingestOpenApi('test-pets', OPENAPI_SPEC);
    const all = ingestion.listAll();
    expect(all.length).toBe(3);
    for (const def of all) {
      const again = ingestion.get(def.tool_id);
      expect(again).toEqual(def);
    }
    expect(ingestion.getForConnector('test-pets').length).toBe(3);
  });

  it('upserts cleanly on re-ingest (no duplicates)', () => {
    ingestion.ingestOpenApi('test-pets', OPENAPI_SPEC);
    ingestion.ingestOpenApi('test-pets', OPENAPI_SPEC);
    expect(ingestion.count()).toBe(3);
  });
});
