// Google Health API v4 responses → rows (pure, unit-tested on the samples from the docs,
// docs/research/google-health-api.md). Zero fields are dropped by the API: `"time": {}` is
// midnight, a missing value is «no data»; 64-bit counts come as strings, durations as "900s".

export type CivilDate = { year?: number; month?: number; day?: number };
export type Interval = { startTime?: string; startUtcOffset?: string; endTime?: string; endUtcOffset?: string };

export function dateKey(d: CivilDate | undefined): string | null {
  if (!d?.year || !d.month || !d.day) return null;
  return `${d.year}-${String(d.month).padStart(2, '0')}-${String(d.day).padStart(2, '0')}`;
}

export const seconds = (s: string | undefined): number | null => {
  const m = s?.match(/^(-?\d+(?:\.\d+)?)s$/);
  return m ? Number(m[1]) : null;
};

const toNum = (v: unknown): number | null => {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : Number.NaN;
  return Number.isFinite(n) ? n : null;
};

/** The local calendar date of an instant with its UTC offset ("18000s" = UTC+5). */
export function localDate(utc: string | undefined, offset: string | undefined): string | null {
  if (!utc) return null;
  const t = Date.parse(utc);
  if (Number.isNaN(t)) return null;
  return new Date(t + (seconds(offset) ?? 0) * 1000).toISOString().slice(0, 10);
}

type RollupPoint = { civilStartTime?: { date?: CivilDate }; steps?: { countSum?: string | number }; activeEnergyBurned?: { kcalSum?: number }; totalCalories?: { kcalSum?: number } };

/** dailyRollUp → { 'YYYY-MM-DD': value } for steps / active / total calories. */
export function parseDailyRollup(body: { rollupDataPoints?: RollupPoint[] } | null, kind: 'steps' | 'active' | 'total'): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of body?.rollupDataPoints ?? []) {
    const day = dateKey(p.civilStartTime?.date);
    if (!day) continue;
    const v = kind === 'steps' ? toNum(p.steps?.countSum) : kind === 'active' ? toNum(p.activeEnergyBurned?.kcalSum) : toNum(p.totalCalories?.kcalSum);
    if (v != null) out[day] = v;
  }
  return out;
}

type RestingPoint = { dailyRestingHeartRate?: { date?: CivilDate; beatsPerMinute?: string | number } };

export function parseRestingHr(body: { dataPoints?: RestingPoint[] } | null): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of body?.dataPoints ?? []) {
    const day = dateKey(p.dailyRestingHeartRate?.date);
    const bpm = toNum(p.dailyRestingHeartRate?.beatsPerMinute);
    if (day && bpm != null) out[day] = bpm;
  }
  return out;
}

export type SleepRow = { night_of: string; start_at: string | null; end_at: string | null; minutes: number | null; stages: Record<string, number> };

type SleepPoint = {
  sleep?: {
    interval?: Interval; type?: string;
    metadata?: { mainSleep?: boolean; main?: boolean };
    summary?: { minutesAsleep?: string | number; minutesInSleepPeriod?: string | number; stagesSummary?: { type?: string; minutes?: string | number }[] };
  };
};

/** Main sleep per wake-up day (the longest when there are several); naps are skipped. */
export function parseSleep(body: { dataPoints?: SleepPoint[] } | null): SleepRow[] {
  const byNight = new Map<string, SleepRow>();
  for (const p of body?.dataPoints ?? []) {
    const s = p.sleep;
    if (!s?.interval) continue;
    const main = s.metadata?.mainSleep ?? s.metadata?.main ?? true;
    if (!main) continue;
    const night = localDate(s.interval.endTime, s.interval.endUtcOffset);
    if (!night) continue;
    const stages: Record<string, number> = {};
    for (const st of s.summary?.stagesSummary ?? []) {
      const m = toNum(st.minutes);
      if (st.type && m != null) stages[st.type.toLowerCase()] = m;
    }
    const row: SleepRow = {
      night_of: night, start_at: s.interval.startTime ?? null, end_at: s.interval.endTime ?? null,
      minutes: toNum(s.summary?.minutesAsleep) ?? toNum(s.summary?.minutesInSleepPeriod), stages,
    };
    const prev = byNight.get(night);
    if (!prev || (row.minutes ?? 0) > (prev.minutes ?? 0)) byNight.set(night, row);
  }
  return [...byNight.values()];
}

export type WorkoutRow = {
  external_id: string; local_day: string; kind: string; started_at: string | null; ended_at: string | null;
  duration_min: number | null; kcal: number | null; avg_hr: number | null;
};

type ExercisePoint = {
  name?: string; dataPointName?: string;
  exercise?: { interval?: Interval; exerciseType?: string; displayName?: string; activeDuration?: string; metricsSummary?: { caloriesKcal?: number; averageHeartRateBeatsPerMinute?: string | number } };
};

export function parseExercise(body: { dataPoints?: ExercisePoint[] } | null): WorkoutRow[] {
  const out: WorkoutRow[] = [];
  for (const p of body?.dataPoints ?? []) {
    const e = p.exercise;
    const id = p.name ?? p.dataPointName;
    if (!e?.interval || !id) continue;
    const day = localDate(e.interval.startTime, e.interval.startUtcOffset);
    if (!day) continue;
    const active = seconds(e.activeDuration);
    const span = e.interval.startTime && e.interval.endTime ? (Date.parse(e.interval.endTime) - Date.parse(e.interval.startTime)) / 1000 : null;
    out.push({
      external_id: id.split('/').pop() ?? id, local_day: day, kind: (e.exerciseType ?? e.displayName ?? 'exercise').toLowerCase(),
      started_at: e.interval.startTime ?? null, ended_at: e.interval.endTime ?? null,
      duration_min: active != null ? Math.round(active / 60) : span != null ? Math.round(span / 60) : null,
      kcal: toNum(e.metricsSummary?.caloriesKcal), avg_hr: toNum(e.metricsSummary?.averageHeartRateBeatsPerMinute),
    });
  }
  return out;
}

/** Inclusive-exclusive civil range for dailyRollUp. */
export function rollupRange(from: string, toExclusive: string) {
  const civil = (d: string) => { const [year, month, day] = d.split('-').map(Number); return { date: { year, month, day }, time: {} }; };
  return { range: { start: civil(from), end: civil(toExclusive) }, windowSizeDays: 1 };
}
