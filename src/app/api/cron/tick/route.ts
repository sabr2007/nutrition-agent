import { json } from '@/lib/http';
import { isCronRequest } from '@/lib/cron-auth';
import { supabaseAdmin } from '@/lib/supabase/server';
import { runTick } from '@/lib/reminders/engine';

export const maxDuration = 300;

// Triggered every 5 minutes by Supabase pg_cron (POST) or Vercel Cron (GET).
async function tick(req: Request): Promise<Response> {
  if (!isCronRequest(req)) return json({ error: { message: 'unauthorized', code: 'unauthorized' } }, 401);
  const t0 = Date.now();
  const reports = await runTick(supabaseAdmin());
  return json({ ok: true, ms: Date.now() - t0, users: reports.length, sent: reports.flatMap((r) => r.sent), errors: reports.flatMap((r) => r.errors) });
}

export const POST = tick;
export const GET = tick;
