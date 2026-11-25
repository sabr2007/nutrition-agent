import { after } from 'next/server';
import { json } from '@/lib/http';
import { isCronRequest } from '@/lib/cron-auth';
import { supabaseAdmin } from '@/lib/supabase/server';
import { runTick } from '@/lib/reminders/engine';
import { retryTelegram } from '@/lib/telegram/deps';
import { staleConnections, syncGoogleHealth } from '@/lib/health/sync';
import { getProfile, todayFor } from '@/lib/data/profile';
import { instantForLocal } from '@/lib/nutrition/day';

export const maxDuration = 300;

// Triggered every 5 minutes by Supabase pg_cron (POST) or Vercel Cron (GET).
/** POST {"preview": true, "at": "15:30"}: the rules as they would fire today at that local time — nothing sent or written. */
async function preview(req: Request): Promise<Response | null> {
  if (req.method !== 'POST') return null;
  const body = (await req.clone().json().catch(() => null)) as { preview?: boolean; at?: string } | null;
  if (!body?.preview) return null;
  const admin = supabaseAdmin();
  const { data: owner } = await admin.from('profiles').select('user_id').limit(1).maybeSingle();
  if (!owner) return json({ ok: false, error: 'no profile' });
  const profile = await getProfile(admin, owner.user_id as string);
  const at = /^\d\d:\d\d$/.test(body.at ?? '') ? body.at! : null;
  const now = at ? instantForLocal(todayFor(profile), at, profile.timezone, profile.day_boundary_minutes) : new Date();
  const reports = await runTick(admin, now, async () => 0, { preview: true });
  return json({ ok: true, preview: true, at: now.toISOString(), reports: reports.map((r) => ({ considered: r.considered, would_send: r.sent, skipped: r.skipped, errors: r.errors, facts: r.facts })) });
}

async function tick(req: Request): Promise<Response> {
  if (!isCronRequest(req)) return json({ error: { message: 'unauthorized', code: 'unauthorized' } }, 401);
  const previewed = await preview(req);
  if (previewed) return previewed;
  const t0 = Date.now();
  // Telegram safety net (stuck or failed updates) runs after the response: pg_net waits only 25 s.
  after(async () => {
    try {
      await retryTelegram();
    } catch (e) {
      console.error('[cron] telegram retry failed', (e as Error).message?.slice(0, 200));
    }
    // Google Health: poll connected owners whose data is older than 15 minutes.
    try {
      const admin = supabaseAdmin();
      for (const userId of await staleConnections(admin)) await syncGoogleHealth(admin, userId, await getProfile(admin, userId));
    } catch (e) {
      console.error('[cron] health sync failed', (e as Error).message?.slice(0, 200));
    }
  });
  const reports = await runTick(supabaseAdmin());
  return json({ ok: true, ms: Date.now() - t0, users: reports.length, sent: reports.flatMap((r) => r.sent), errors: reports.flatMap((r) => r.errors) });
}

export const POST = tick;
export const GET = tick;
