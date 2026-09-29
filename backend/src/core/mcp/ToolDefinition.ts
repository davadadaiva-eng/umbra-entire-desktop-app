/**
 * ToolDefinition — the standardized per-tool metadata contract.
 *
 * Every callable tool (from the curated set, an OpenAPI/Swagger ingestion, or
 * an MCP `tools/list` response) is normalized into this shape so the
 * retrieval layer, the LLM orchestration layer, and the executor all speak
 * the same language:
 *
 *   retrieval  → top-K ToolDefinitions (JIT, never the whole catalog)
 *   LLM        → native `tools` declarations (or JSON-mode prompt) built
 *                from `parameters_schema`
 *   executor   → Zod/JSON-Schema validation of the LLM's arguments BEFORE
 *                any HTTP request leaves the machine
 */

import { z } from 'zod';

// ── JSON Schema (subset) ────────────────────────────────────────────
/**
 * The subset of JSON Schema Draft-07 that tool parameter schemas use:
 * objects with typed properties, enums, arrays, and primitive types.
 * Anything richer is still accepted here (validated structurally) but the
 * executor only enforces the subset below.
 */
export interface JsonSchemaProperty {
  type: 'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array';
  description?: string;
  enum?: Array<string | number>;
  items?: JsonSchemaProperty;
  properties?: Record<string, JsonSchemaProperty>;
  required?: string[];
  default?: unknown;
  /** Free-form extras (format, minimum, …) preserved but not enforced. */
  [key: string]: unknown;
}

export interface JsonSchemaObject {
  type: 'object';
  properties: Record<string, JsonSchemaProperty>;
  required?: string[];
  additionalProperties?: boolean;
  [key: string]: unknown;
}

const propertySchema: z.ZodType<JsonSchemaProperty> = z.lazy(() =>
  z.object({
    type: z.enum(['string', 'number', 'integer', 'boolean', 'object', 'array']),
    description: z.string().optional(),
    enum: z.array(z.union([z.string(), z.number()])).optional(),
    items: propertySchema.optional(),
    properties: z.record(propertySchema).optional(),
    required: z.array(z.string()).optional(),
    default: z.unknown().optional(),
  }).passthrough(),
) as z.ZodType<JsonSchemaProperty>;

export const JsonSchemaObjectSchema: z.ZodType<JsonSchemaObject> = z.lazy(() =>
  z.object({
    type: z.literal('object'),
    properties: z.record(propertySchema),
    required: z.array(z.string()).optional(),
    additionalProperties: z.boolean().optional(),
  }).passthrough(),
) as z.ZodType<JsonSchemaObject>;

// ── ToolDefinition ──────────────────────────────────────────────────

export type ToolAuthType = 'none' | 'apiKey' | 'bearer' | 'oauth';
export type ToolTransport = 'rest' | 'mcp' | 'webhook';
/** How trustworthy the parameter schema is — retrieval prefers higher fidelity. */
export type SchemaQuality = 'curated' | 'openapi' | 'mcp' | 'generic';

export const ToolDefinitionSchema = z.object({
  /** Globally unique: `${connector_id}.${tool_name}`. */
  tool_id: z.string().min(1),
  /** Catalog connector slug (e.g. `communication-gmail`). */
  connector_id: z.string().min(1),
  /** Short function-style name for LLM tool calling (e.g. `send_message`). */
  name: z.string().min(1),
  natural_language_description: z.string().min(1),
  category: z.string().default('Other'),
  parameters_schema: JsonSchemaObjectSchema,
  auth_type: z.enum(['none', 'apiKey', 'bearer', 'oauth']).default('none'),
  transport: z.enum(['rest', 'mcp', 'webhook']).default('rest'),
  /** Path template for REST tools, e.g. `/gmail/v1/messages/send`. */
  endpoint_template: z.string().optional(),
  base_url: z.string().optional(),
  http_method: z.enum(['GET', 'POST', 'PUT', 'DELETE', 'PATCH']).optional(),
  /** CredentialVault / ConnectorStore service key for secret resolution. */
  credential_service: z.string().optional(),
  api_key_header: z.string().optional(),
  schema_quality: z.enum(['curated', 'openapi', 'mcp', 'generic']).default('generic'),
  /** Where this definition came from (for debugging/auditing). */
  source: z.string().optional(),
  updated_at: z.string().optional(),
});

export type ToolDefinition = z.infer<typeof ToolDefinitionSchema>;

export function makeToolId(connectorId: string, toolName: string): string {
  return `${connectorId}.${toolName}`;
}

/**
 * LLM-facing function name. Must match `^[a-zA-Z0-9_-]{1,64}$` for
 * OpenAI/Anthropic/Ollama — dots are not allowed, so `gmail.send_message`
 * becomes `gmail_send_message`.
 */
export function toolFunctionName(def: Pick<ToolDefinition, 'tool_id'>): string {
  return def.tool_id.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
}

// ── Argument validation (JSON-Schema subset) ────────────────────────

export interface ArgValidationResult {
  ok: boolean;
  /** Human-readable, LLM-feedable errors (one corrective retry friendly). */
  errors: string[];
}

function checkValue(
  path: string,
  value: unknown,
  prop: JsonSchemaProperty,
  errors: string[],
): void {
  if (value === undefined || value === null) return; // presence handled by required

  switch (prop.type) {
    case 'string':
      if (typeof value !== 'string') errors.push(`${path} must be a string (got ${typeof value})`);
      else if (prop.enum && !prop.enum.includes(value)) errors.push(`${path} must be one of: ${prop.enum.join(', ')}`);
      break;
    case 'number':
    case 'integer': {
      const isNum = typeof value === 'number' && Number.isFinite(value);
      if (!isNum) errors.push(`${path} must be a number (got ${typeof value})`);
      else if (prop.type === 'integer' && !Number.isInteger(value)) errors.push(`${path} must be an integer`);
      else if (prop.enum && !prop.enum.includes(value)) errors.push(`${path} must be one of: ${prop.enum.join(', ')}`);
      break;
    }
    case 'boolean':
      if (typeof value !== 'boolean') errors.push(`${path} must be a boolean (got ${typeof value})`);
      break;
    case 'object': {
      if (typeof value !== 'object' || Array.isArray(value)) {
        errors.push(`${path} must be an object`);
        break;
      }
      const rec = value as Record<string, unknown>;
      for (const req of prop.required ?? []) {
        if (rec[req] === undefined) errors.push(`${path}.${req} is required`);
      }
      for (const [k, sub] of Object.entries(prop.properties ?? {})) {
        if (rec[k] !== undefined) checkValue(`${path}.${k}`, rec[k], sub, errors);
      }
      break;
    }
    case 'array': {
      if (!Array.isArray(value)) {
        errors.push(`${path} must be an array`);
        break;
      }
      if (prop.items) value.forEach((v, i) => checkValue(`${path}[${i}]`, v, prop.items!, errors));
      break;
    }
  }
}

/**
 * Validate LLM-produced tool arguments against a ToolDefinition's
 * `parameters_schema` BEFORE execution. Never throws — returns feedable
 * errors so the agent loop can correct and retry once.
 */
export function validateToolArgs(
  args: Record<string, unknown>,
  schema: JsonSchemaObject,
): ArgValidationResult {
  const errors: string[] = [];
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return { ok: false, errors: ['arguments must be a JSON object'] };
  }
  for (const req of schema.required ?? []) {
    if (args[req] === undefined) errors.push(`${req} is required`);
  }
  for (const [k, prop] of Object.entries(schema.properties ?? {})) {
    if (args[k] !== undefined) checkValue(k, args[k], prop, errors);
  }
  return { ok: errors.length === 0, errors };
}

/** Parse a persisted definition row (JSON) back into a validated ToolDefinition. */
export function parseToolDefinition(json: string | Record<string, unknown>): ToolDefinition | null {
  const raw = typeof json === 'string' ? safeParse(json) : json;
  if (!raw) return null;
  // Tolerate persisted rows where parameters_schema was stored as a JSON string.
  if (typeof raw.parameters_schema === 'string') {
    const schema = safeParse(raw.parameters_schema);
    if (!schema) return null;
    raw.parameters_schema = schema;
  }
  const parsed = ToolDefinitionSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

function safeParse(s: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(s);
    return v && typeof v === 'object' ? v : null;
  } catch {
    return null;
  }
}
