/**
 * Umbra OS — zod body-validation helpers.
 * Modeled on openmuse `apps/server/src/app.ts` onError mapping:
 *   ZodError -> HTTP 422 with joined issue messages.
 */
import { z } from 'zod';
import { AppError } from './AppError';

/** Parse `data` with a zod schema; throw AppError(422) on ZodError. */
export function parseOr422<T>(schema: z.ZodType<T>, data: unknown): T {
  try {
    return schema.parse(data);
  } catch (err) {
    if (err instanceof z.ZodError) {
      throw new AppError(formatZodIssues(err), 422);
    }
    throw err;
  }
}

/** Async variant for schemas with async refinements. */
export async function parseOr422Async<T>(schema: z.ZodType<T>, data: unknown): Promise<T> {
  try {
    return await schema.parseAsync(data);
  } catch (err) {
    if (err instanceof z.ZodError) {
      throw new AppError(formatZodIssues(err), 422);
    }
    throw err;
  }
}

/**
 * Validate a JSON body object against a zod object schema.
 * Accepts the raw `body` map passed to ApiServer handlers.
 */
export function validateBody<T extends z.ZodTypeAny>(
  schema: T,
  body: Record<string, unknown>,
): z.infer<T> {
  return parseOr422(schema, body);
}

/** Validate URL query params (URLSearchParams -> plain object) with a schema. */
export function validateQuery<T extends z.ZodTypeAny>(
  schema: T,
  url: URL,
): z.infer<T> {
  const raw: Record<string, string> = {};
  url.searchParams.forEach((value, key) => {
    raw[key] = value;
  });
  return parseOr422(schema as unknown as z.ZodType<z.infer<T>>, raw);
}

/** Require a non-empty string field; throws AppError(400) when missing. */
export function requireString(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  const parsed = z.string().min(1).safeParse(typeof value === 'string' ? value.trim() : value);
  if (!parsed.success) {
    throw new AppError(`${field} is required`, 400);
  }
  return parsed.data;
}

/** Optional string field helper (undefined when absent). */
export function optionalString(body: Record<string, unknown>, field: string): string | undefined {
  const value = body[field];
  if (value === undefined) return undefined;
  return String(value);
}

/** Common reusable schemas for route handlers. */
export const commonSchemas = {
  idParam: z.string().min(1).max(256),
  pagination: z.object({
    limit: z.coerce.number().int().min(1).max(100).optional(),
    offset: z.coerce.number().int().min(0).optional(),
    q: z.string().max(1024).optional(),
  }),
  taskCreate: z.object({
    description: z.string().trim().min(1, 'description is required').max(10000),
    priority: z.coerce.number().int().optional(),
  }),
  chat: z.object({
    message: z.string().trim().min(1, 'message is required').max(10000).optional(),
    text: z.string().trim().min(1).max(10000).optional(),
    target: z.string().max(64).optional(),
  }),
};

/**
 * Join zod issues into one message a client can act on.
 *
 * The field path is included: a bare zod `message` is frequently just
 * "Required" / "Invalid enum value. Expected 'a' | 'b'", which tells the caller
 * nothing about WHICH field to fix. Root-level issues (empty path) are emitted
 * unprefixed.
 */
function formatZodIssues(err: z.ZodError): string {
  const msg = err.issues
    .map((i) => {
      const field = i.path.join('.');
      return field ? `${field}: ${i.message}` : i.message;
    })
    .join('; ');
  return msg || 'Invalid request data';
}

/** True when an error is a zod validation failure (for ApiServer mapping). */
export function isZodError(err: unknown): err is z.ZodError {
  return err instanceof z.ZodError;
}
