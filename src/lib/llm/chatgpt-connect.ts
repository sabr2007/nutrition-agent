import { z } from 'zod';

// Shape of the ChatGPT plan credentials that the local login CLI (scripts/chatgpt-login.ts)
// hands to the backend. Shared by the route, the CLI and tests, so no server-only imports.

export const PLAN_SCOPE = 'chatgpt.tokens.use.direct';
/** OpenAI documents a 1-hour access token; more than a day means a malformed response. */
const MAX_ACCESS_TTL_S = 86_400;
/** A numeric timestamp below this is in seconds, above it in milliseconds. */
const EPOCH_MS_FLOOR = 1e12;
const NUMERIC = /^\d+(\.\d+)?$/;

/** OpenAI does not document the type of `earliest_refresh_at`: accepts epoch seconds/ms or a date string. */
export function toIsoTimestamp(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? value : NUMERIC.test(value.trim()) ? Number(value) : Number.NaN;
  const ms = Number.isNaN(n) ? Date.parse(String(value)) : n < EPOCH_MS_FLOOR ? n * 1000 : n;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export const ConnectBody = z.object({
  access_token: z.string().min(20).max(20_000),
  refresh_token: z.string().min(10).max(20_000),
  expires_in: z.coerce.number().int().positive().max(MAX_ACCESS_TTL_S),
  scope: z.string().max(1000),
  client_id: z.string().regex(/^oaiapp_[A-Za-z0-9_-]+$/),
  earliest_refresh_at: z.union([z.string().max(64), z.number()]).nullish().transform(toIsoTimestamp),
});

export type ConnectPayload = z.infer<typeof ConnectBody>;

export function hasPlanScope(scope: string): boolean {
  return scope.split(/\s+/).includes(PLAN_SCOPE);
}

/** Names of the fields that failed validation, never their values (they are tokens). */
export function invalidFields(error: z.ZodError): string[] {
  return [...new Set(error.issues.map((issue) => String(issue.path[0] ?? 'body')))];
}
