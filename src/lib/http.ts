import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { unstable_rethrow } from 'next/navigation';
import { supabaseAsUser } from '@/lib/supabase/server';

export class HttpError extends Error {
  constructor(public status: number, message: string, public code?: string) {
    super(message);
  }
}

export type UserCtx = { userId: string; token: string; sb: SupabaseClient };

/** Verifies the bearer token (JWT) and returns a user-scoped Supabase client. */
export async function requireUser(req: Request): Promise<UserCtx> {
  const header = req.headers.get('authorization') ?? '';
  const token = header.replace(/^Bearer\s+/i, '').trim();
  const path = new URL(req.url).pathname;
  // Why a request was refused, and whether the page had to put a lost session back (D32). No token
  // contents, no user ids.
  if (req.headers.get('x-session-restored')) console.info('[auth] session restored from page memory', { path });
  if (!token) {
    console.warn('[auth] 401', { path, reason: 'no_token' });
    throw new HttpError(401, 'Нужно войти', 'unauthenticated');
  }
  const sb = supabaseAsUser(token);
  const { data, error } = await sb.auth.getClaims(token);
  const sub = data?.claims?.sub;
  if (error || !sub) {
    console.warn('[auth] 401', { path, reason: 'invalid_token', error: error?.name, detail: error?.message?.slice(0, 120) });
    throw new HttpError(401, 'Сессия истекла, войди снова', 'invalid_token');
  }
  return { userId: sub, token, sb };
}

export function json(data: unknown, init?: number | ResponseInit): Response {
  const resInit = typeof init === 'number' ? { status: init } : init;
  return Response.json(data, resInit);
}

/** Wraps a route handler: consistent error shape, no PII in logs. */
export function handler<T extends unknown[]>(fn: (req: Request, ...rest: T) => Promise<Response>) {
  return async (req: Request, ...rest: T): Promise<Response> => {
    try {
      return await fn(req, ...rest);
    } catch (err) {
      unstable_rethrow(err); // let Next.js internal control-flow errors (prerender bailout etc.) through
      if (err instanceof HttpError) {
        return json({ error: { message: err.message, code: err.code ?? 'error' } }, err.status);
      }
      const e = err as Error;
      console.error('[api] unhandled', { name: e?.name, message: e?.message?.slice(0, 300) });
      return json({ error: { message: 'Что-то пошло не так. Попробуй ещё раз.', code: 'internal' } }, 500);
    }
  };
}

export async function readJson<T>(req: Request): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch {
    throw new HttpError(400, 'Некорректный JSON', 'bad_json');
  }
}
