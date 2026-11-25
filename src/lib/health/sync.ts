import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { addDays } from '@/lib/nutrition/day';
import { todayFor, type Profile } from '@/lib/data/profile';
import { API, googleToken, PROVIDER, readConnection } from './google';
import { parseDailyRollup, parseExercise, parseRestingHr, parseSleep, rollupRange } from './parse';

// Polling sync (D28): every 15 minutes from the cron tick for connected owners, and on demand
// from get_activity when the data is stale. Webhooks need a service account and still require
// fetching the data, so polling is the simpler start.

export const SYNC_EVERY_MS = 15 * 60_000;
const FIRST_SYNC_DAYS = 7;
const REGULAR_DAYS = 2;

type Fetch = (path: string, init?: { method?: string; body?: unknown }) => Promise<unknown>;

function client(token: string): Fetch {
  return async (path, init) => {
    const res = await fetch(`${API}${path}`, {
      method: init?.method ?? 'GET',
      headers: { Authorization: `Bearer ${token}`, ...(init?.body ? { 'Content-Type': 'application/json' } : {}) },
      body: init?.body ? JSON.stringify(init.body) : undefined,
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw Object.assign(new Error(`google health ${res.status}: ${text.slice(0, 160)}`), { status: res.status });
    }
    return res.json();
  };
}

const q = (filter: string, extra = '') => `?filter=${encodeURIComponent(filter)}${extra}`;

async function tryBoth(get: Fetch, paths: string[]): Promise<unknown> {
  let last: unknown;
  for (const p of paths) {
    try {
      return await get(p);
    } catch (e) {
      last = e;
      if ((e as { status?: number }).status !== 400) throw e;
    }
  }
  throw last;
}

export type SyncReport = { ok: boolean; days: number; sleeps: number; workouts: number; error?: string };

/** Pulls the last days from Google Health into health_daily / health_sleep / workouts. */
export async function syncGoogleHealth(admin: SupabaseClient, userId: string, profile: Profile, opts: { days?: number } = {}): Promise<SyncReport> {
  const conn = await readConnection(admin, userId);
  if (!conn || conn.status !== 'connected') return { ok: false, days: 0, sleeps: 0, workouts: 0, error: 'not_connected' };
  const token = await googleToken(userId);
  if (!token) return { ok: false, days: 0, sleeps: 0, workouts: 0, error: 'token' };
  const get = client(token);
  const today = todayFor(profile);
  const days = opts.days ?? (conn.meta?.last_sync_at ? REGULAR_DAYS : FIRST_SYNC_DAYS);
  const from = addDays(today, -(days - 1));
  const to = addDays(today, 1);
  try {
    const roll = (type: string) => get(`/dataTypes/${type}/dataPoints:dailyRollUp`, { method: 'POST', body: rollupRange(from, to) });
    const [steps, active, total, resting, sleep, exercise] = await Promise.all([
      roll('steps').then((b) => parseDailyRollup(b as never, 'steps')),
      roll('active-energy-burned').then((b) => parseDailyRollup(b as never, 'active')).catch(() => ({})),
      roll('total-calories').then((b) => parseDailyRollup(b as never, 'total')).catch(() => ({})),
      tryBoth(get, [
        `/dataTypes/daily-resting-heart-rate/dataPoints${q(`daily_resting_heart_rate.date >= "${from}" AND daily_resting_heart_rate.date < "${to}"`)}`,
        `/dataTypes/daily-resting-heart-rate/dataPoints${q(`dailyRestingHeartRate.date >= "${from}" AND dailyRestingHeartRate.date < "${to}"`)}`,
      ]).then((b) => parseRestingHr(b as never)).catch(() => ({})),
      get(`/dataTypes/sleep/dataPoints:reconcile${q(`sleep.interval.civil_end_time >= "${from}" AND sleep.interval.civil_end_time < "${to}"`, '&pageSize=25')}`).then((b) => parseSleep(b as never)).catch(() => []),
      get(`/dataTypes/exercise/dataPoints${q(`exercise.interval.civil_start_time >= "${from}T00:00:00" AND exercise.interval.civil_start_time < "${to}T00:00:00"`, '&pageSize=25')}`).then((b) => parseExercise(b as never)).catch(() => []),
    ]);
    const now = new Date().toISOString();
    const dayKeys = [...new Set([...Object.keys(steps), ...Object.keys(active), ...Object.keys(total), ...Object.keys(resting)])];
    if (dayKeys.length) {
      const { error } = await admin.from('health_daily').upsert(dayKeys.map((d) => ({
        user_id: userId, local_day: d, source: PROVIDER, steps: steps[d] ?? null, active_kcal: (active as Record<string, number>)[d] ?? null,
        total_kcal: (total as Record<string, number>)[d] ?? null, resting_hr: (resting as Record<string, number>)[d] ?? null, synced_at: now,
      })), { onConflict: 'user_id,local_day,source' });
      if (error) throw new Error(`health_daily: ${error.code}`);
    }
    if (sleep.length) {
      const { error } = await admin.from('health_sleep').upsert(sleep.map((s) => ({ user_id: userId, source: PROVIDER, synced_at: now, ...s })), { onConflict: 'user_id,night_of,source' });
      if (error) throw new Error(`health_sleep: ${error.code}`);
    }
    const changed = await changedWorkouts(admin, userId, exercise);
    if (changed.length) {
      const { error } = await admin.from('workouts').upsert(changed.map((w) => ({ user_id: userId, source: PROVIDER, ...w })), { onConflict: 'user_id,source,external_id' });
      if (error) throw new Error(`workouts: ${error.code}`);
    }
    await admin.from('provider_connections').update({ meta: { ...conn.meta, last_sync_at: now, last_error: null } }).eq('id', conn.id);
    return { ok: true, days: dayKeys.length, sleeps: sleep.length, workouts: exercise.length };
  } catch (e) {
    const error = (e as Error).message.slice(0, 200);
    await admin.from('provider_connections').update({ meta: { ...conn.meta, last_error: error, last_error_at: new Date().toISOString() } }).eq('id', conn.id);
    return { ok: false, days: 0, sleeps: 0, workouts: 0, error };
  }
}

type Exercise = ReturnType<typeof parseExercise>[number];
const WORKOUT_FIELDS = ['local_day', 'kind', 'started_at', 'ended_at', 'duration_min', 'kcal', 'avg_hr'] as const;

/** Sessions that are new or differ from the stored copy: every write is journaled, re-syncs are not news. */
async function changedWorkouts(admin: SupabaseClient, userId: string, sessions: Exercise[]): Promise<Exercise[]> {
  if (!sessions.length) return [];
  const { data } = await admin.from('workouts').select('external_id, local_day, kind, started_at, ended_at, duration_min, kcal, avg_hr').eq('user_id', userId).eq('source', PROVIDER)
    .in('external_id', sessions.map((s) => s.external_id));
  const stored = new Map((data ?? []).map((r) => [String(r.external_id), r as Record<string, unknown>]));
  const same = (a: unknown, b: unknown) => (a == null && b == null) || (a != null && b != null && (typeof b === 'number' ? Number(a) === b : String(a) === String(b) || Date.parse(String(a)) === Date.parse(String(b))));
  return sessions.filter((s) => {
    const old = stored.get(s.external_id);
    return !old || WORKOUT_FIELDS.some((f) => !same(old[f], s[f]));
  });
}

/** Connected owners whose data is older than SYNC_EVERY_MS. */
export async function staleConnections(admin: SupabaseClient): Promise<string[]> {
  const { data } = await admin.from('provider_connections').select('user_id, meta').eq('provider', PROVIDER).eq('status', 'connected');
  const cutoff = Date.now() - SYNC_EVERY_MS;
  return (data ?? []).filter((c) => !c.meta?.last_sync_at || Date.parse(String(c.meta.last_sync_at)) < cutoff).map((c) => c.user_id as string);
}
