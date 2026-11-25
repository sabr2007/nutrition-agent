import { after } from 'next/server';
import { json } from '@/lib/http';
import { isCronRequest } from '@/lib/cron-auth';
import { supabaseAdmin } from '@/lib/supabase/server';
import { runTick } from '@/lib/reminders/engine';
import { retryTelegram } from '@/lib/telegram/deps';

export const maxDuration = 300;

// Triggered every 5 minutes by Supabase pg_cron (POST) or Vercel Cron (GET).
async function tick(req: Request): Promise<Response> {
  if (!isCronRequest(req)) return json({ error: { message: 'unauthorized', code: 'unauthorized' } }, 401);
  const t0 = Date.now();
  // Telegram safety net (stuck or failed updates) runs after the response: pg_net waits only 25 s.
  after(async () => {
    try {
      await retryTelegram();
    } catch (e) {
      console.error('[cron] telegram retry failed', (e as Error).message?.slice(0, 200));
    }
  });
  const reports = await runTick(supabaseAdmin());
  return json({ ok: true, ms: Date.now() - t0, users: reports.length, sent: reports.flatMap((r) => r.sent), errors: reports.flatMap((r) => r.errors) });
}

export const POST = tick;
export const GET = tick;
