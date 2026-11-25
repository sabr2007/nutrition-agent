'use client';

// The last good copy of each day's screen, per device (D31). «Сегодня» renders it at once and
// revalidates in the background, so a known day never shows a loading screen. Small and bounded:
// the newest DAYS_KEPT days only. Storage can be unavailable (private mode) — then it is a no-op.

const PREFIX = 'day-cache:';
const DAYS_KEPT = 10;

export function readDay<T>(key: string): T | undefined {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    return raw ? (JSON.parse(raw) as { data: T }).data : undefined;
  } catch {
    return undefined;
  }
}

export function writeDay(key: string, data: unknown): void {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify({ at: Date.now(), data }));
    const keys = Object.keys(localStorage).filter((k) => k.startsWith(PREFIX));
    if (keys.length <= DAYS_KEPT) return;
    const byAge = keys.map((k) => ({ k, at: (JSON.parse(localStorage.getItem(k) ?? '{}') as { at?: number }).at ?? 0 })).sort((a, b) => a.at - b.at);
    for (const { k } of byAge.slice(0, keys.length - DAYS_KEPT)) localStorage.removeItem(k);
  } catch {
    // a cache is a nicety
  }
}
