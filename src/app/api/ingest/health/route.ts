import { createHash } from 'node:crypto';
import { z } from 'zod';
import { rateLimit } from '@/lib/ratelimit';
import { handler, HttpError, json, readJson } from '@/lib/http';
import { supabaseAdmin } from '@/lib/supabase/server';
import { getProfile, todayFor } from '@/lib/data/profile';

// Apple Shortcuts → POST JSON with the per-user token (docs/research/ios-pwa-push.md, Health import).
// { "steps": 12345, "sleep_hours": 7.2, "date": "2026-11-24" }  — date defaults to the current local day;
// sleep is stored for its wake-up day (the night that ended that morning).
const Body = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  steps: z.number().int().min(0).max(150_000).optional(),
  sleep_hours: z.number().min(0).max(24).optional(),
});

export const POST = handler(async (req) => {
  const token = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (!token.startsWith('rh_')) throw new HttpError(401, 'invalid token', 'unauthorized');
  rateLimit(`ingest:${token.slice(0, 12)}`, 30, 60 * 60_000);
  const parsed = Body.safeParse(await readJson(req));
  if (!parsed.success) throw new HttpError(400, 'invalid payload', 'validation');
  const admin = supabaseAdmin();
  const hash = createHash('sha256').update(token).digest('hex');
  const { data: prof } = await admin.from('profiles').select('user_id').eq('settings->>health_token_sha256', hash).maybeSingle();
  if (!prof) throw new HttpError(401, 'invalid token', 'unauthorized');
  const userId = prof.user_id as string;
  const profile = await getProfile(admin, userId);
  const today = parsed.data.date ?? todayFor(profile);
  // v2 (D28): the backup source next to Google Health — health_daily / health_sleep, source 'shortcuts'.
  const imported: string[] = [];
  const now = new Date().toISOString();
  if (parsed.data.steps != null) {
    const { error } = await admin.from('health_daily').upsert({ user_id: userId, local_day: today, source: 'shortcuts', steps: parsed.data.steps, synced_at: now }, { onConflict: 'user_id,local_day,source' });
    if (error) throw new HttpError(500, 'db error', 'db');
    imported.push('steps');
  }
  if (parsed.data.sleep_hours != null) {
    // Sleep of the night that ended this morning belongs to today (the wake-up day).
    const night = parsed.data.date ?? today;
    const { error } = await admin.from('health_sleep').upsert({ user_id: userId, night_of: night, source: 'shortcuts', minutes: Math.round(parsed.data.sleep_hours * 60), synced_at: now }, { onConflict: 'user_id,night_of,source' });
    if (error) throw new HttpError(500, 'db error', 'db');
    imported.push('sleep');
  }
  if (!imported.length) throw new HttpError(400, 'nothing to import', 'validation');
  return json({ ok: true, imported });
});
