import { timingSafeEqual } from 'node:crypto';
import { json } from '@/lib/http';
import { serverEnv } from '@/lib/env';
import { supabaseAdmin } from '@/lib/supabase/server';
import { runTick } from '@/lib/reminders/engine';

export const maxDuration = 300;

function authorized(req: Request): boolean {
  const secret = serverEnv().cronSecret;
  const got = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (!secret || !got || got.length !== secret.length) return false;
  return timingSafeEqual(Buffer.from(got), Buffer.from(secret));
}

// Triggered every 5 minutes by Supabase pg_cron (POST) or Vercel Cron (GET).
async function tick(req: Request): Promise<Response> {
  if (!authorized(req)) return json({ error: { message: 'unauthorized', code: 'unauthorized' } }, 401);
  const t0 = Date.now();
  const reports = await runTick(supabaseAdmin());
  return json({ ok: true, ms: Date.now() - t0, users: reports.length, sent: reports.flatMap((r) => r.sent), errors: reports.flatMap((r) => r.errors) });
}

export const POST = tick;
export const GET = tick;
