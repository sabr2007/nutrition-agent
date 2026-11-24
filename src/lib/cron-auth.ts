import 'server-only';
import { timingSafeEqual } from 'node:crypto';
import { serverEnv } from '@/lib/env';

/** True when the request carries the shared cron secret (Supabase pg_cron or Vercel Cron). */
export function isCronRequest(req: Request): boolean {
  const secret = serverEnv().cronSecret;
  const got = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (!secret || !got || got.length !== secret.length) return false;
  return timingSafeEqual(Buffer.from(got), Buffer.from(secret));
}
