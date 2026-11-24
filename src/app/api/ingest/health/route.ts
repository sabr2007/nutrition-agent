import { createHash } from 'node:crypto';
import { z } from 'zod';
import { rateLimit } from '@/lib/ratelimit';
import { handler, HttpError, json, readJson } from '@/lib/http';
import { supabaseAdmin } from '@/lib/supabase/server';
import { getProfile, todayFor } from '@/lib/data/profile';
import { addDays } from '@/lib/nutrition/day';

// Apple Shortcuts → POST JSON with the per-user token (docs/research/ios-pwa-push.md, Health import).
// { "steps": 12345, "sleep_hours": 7.2, "date": "2026-11-24" }  — date defaults to the current local day
// for steps and to the previous night for sleep.
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
  const rows: Record<string, unknown>[] = [];
  if (parsed.data.steps != null) rows.push({ user_id: userId, local_day: today, item_key: 'steps', done: parsed.data.steps >= 12000, value: parsed.data.steps, source: 'import' });
  if (parsed.data.sleep_hours != null) rows.push({ user_id: userId, local_day: parsed.data.date ?? addDays(today, -1), item_key: 'sleep', done: parsed.data.sleep_hours >= 7, value: Math.round(parsed.data.sleep_hours * 10) / 10, source: 'import' });
  if (!rows.length) throw new HttpError(400, 'nothing to import', 'validation');
  const { error } = await admin.from('checklist_marks').insert(rows);
  if (error) throw new HttpError(500, 'db error', 'db');
  return json({ ok: true, imported: rows.map((r) => r.item_key) });
});
