// "Day" logic. The user goes to bed at 2–3 am, so food eaten at 00:30 belongs to the
// previous day. local_day = calendar date (in the user's timezone) of (t - boundary).

export const DEFAULT_TZ = 'Asia/Almaty';
export const DEFAULT_BOUNDARY_MIN = 240;

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function fmt(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
      weekday: 'short',
    });
    fmtCache.set(tz, f);
  }
  return f;
}

export type LocalParts = { date: string; hour: number; minute: number; isoWeekday: number; hhmm: string };

const WEEKDAYS: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

export function localParts(t: Date, tz = DEFAULT_TZ): LocalParts {
  const parts = Object.fromEntries(fmt(tz).formatToParts(t).map((p) => [p.type, p.value]));
  const hour = Number(parts.hour) % 24;
  const minute = Number(parts.minute);
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    hour,
    minute,
    isoWeekday: WEEKDAYS[parts.weekday as string] ?? 1,
    hhmm: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
  };
}

/** Local day (YYYY-MM-DD) that an instant belongs to, honoring the day boundary. */
export function localDay(t: Date, tz = DEFAULT_TZ, boundaryMin = DEFAULT_BOUNDARY_MIN): string {
  return localParts(new Date(t.getTime() - boundaryMin * 60_000), tz).date;
}

/** ISO weekday (1=Mon..7=Sun) of a YYYY-MM-DD date string. */
export function isoWeekdayOf(day: string): number {
  const [y, m, d] = day.split('-').map(Number);
  const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return wd === 0 ? 7 : wd;
}

export function addDays(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return dt.toISOString().slice(0, 10);
}

/** Minutes since local midnight for "HH:MM". */
export function hhmmToMin(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + (m || 0);
}

/**
 * Minutes of the "day clock": minutes since the day boundary. Lets us compare times
 * across midnight (00:30 is later than 21:00 within the same local day).
 */
export function dayClockMin(hhmm: string, boundaryMin = DEFAULT_BOUNDARY_MIN): number {
  return (hhmmToMin(hhmm) - boundaryMin + 1440) % 1440;
}

/** Offset (ms) of a timezone at instant t, e.g. +5h for Asia/Almaty. */
export function tzOffsetMs(t: Date, tz = DEFAULT_TZ): number {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(t).map((x) => [x.type, x.value]),
  );
  const asUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour) % 24, Number(p.minute), Number(p.second));
  return asUtc - Math.floor(t.getTime() / 1000) * 1000;
}

/**
 * Instant for a local wall-clock time within a given local *day* (respecting the
 * boundary): ("2026-11-24", "00:30") => 2026-11-25T00:30 local, because 00:30 is
 * before the 04:00 boundary and therefore still belongs to the 24th.
 */
export function instantForLocal(day: string, hhmm: string, tz = DEFAULT_TZ, boundaryMin = DEFAULT_BOUNDARY_MIN): Date {
  const mins = hhmmToMin(hhmm);
  const calendarDay = mins < boundaryMin ? addDays(day, 1) : day;
  const [y, m, d] = calendarDay.split('-').map(Number);
  const guess = new Date(Date.UTC(y, m - 1, d, Math.floor(mins / 60), mins % 60));
  return new Date(guess.getTime() - tzOffsetMs(guess, tz));
}

export function formatHHMM(t: Date | string, tz = DEFAULT_TZ): string {
  return localParts(typeof t === 'string' ? new Date(t) : t, tz).hhmm;
}
