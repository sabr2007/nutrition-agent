'use client';

import { useSearchParams, useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { api } from '@/lib/client/api';
import { preloadDay, useDay } from '@/lib/client/use-day';
import type { TodayResponse } from '@/lib/client/types';
import { dayTitle, fmt } from '@/lib/client/format';
import { addDays } from '@/lib/nutrition/day';
import { AsciiBar } from '@/components/ui/Ascii';
import { PlateDots } from '@/components/ui/PlateDots';
import { MealList } from './MealList';

// «Сегодня» in the Mini App (v2): the day's header, the top panel and the journal. Logging lives
// in the Telegram chat; templates in one tap — the bot's /today buttons.

export function TodayView() {
  const params = useSearchParams();
  const router = useRouter();
  const day = params.get('day');
  const notifId = params.get('n');
  const key = `/api/today${day ? `?day=${day}` : ''}`;
  // Known day first, fresh data in the background; refresh on return to the app (back from the bot), no polling.
  const { data, error, isLoading, revalidate, setLocal } = useDay<TodayResponse>(key);

  // Opened from a push notification → record the reaction.
  useEffect(() => {
    if (!notifId) return;
    api(`/api/notifications/${notifId}`, { body: { action: 'opened' } }).catch(() => undefined);
  }, [notifId]);

  const s = data?.summary;

  // The neighbouring days are one tap away: fetch them ahead.
  useEffect(() => {
    if (!s) return;
    for (const d of [addDays(s.day, -1), ...(s.isToday ? [] : [addDays(s.day, 1)])]) preloadDay(`/api/today?day=${d}`);
  }, [s?.day, s?.isToday]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Delete without waiting: the meal and its numbers leave the screen at once, back on failure. */
  async function removeMeal(id: string) {
    const before = data;
    setLocal((cur) => withoutMeal(cur, id));
    try {
      await api(`/api/meals/${id}`, { method: 'DELETE' });
    } catch (e) {
      if (before) setLocal(() => before);
      throw e;
    }
    void revalidate();
  }

  if (error && !data) {
    return <div className="p-6"><p className="label">ошибка</p><p className="mt-2 text-ink-2">{(error as Error).message}</p><button className="press mt-4 rounded-full border border-ink px-4 py-2" onClick={() => void revalidate()}>Повторить</button></div>;
  }
  if (isLoading || !s) return <div className="p-6"><span className="ascii text-ink-3 blink">загрузка</span></div>;

  const g = s.goal;
  const t = dayTitle(s.day);
  const kcalShare = g ? s.totals.kcal / g.kcal_max : 0;
  const proteinShare = g ? s.totals.protein_g / g.protein_min_g : 0;
  const prevDay = addDays(s.day, -1);
  const nextDay = addDays(s.day, 1);

  return (
    <main className="px-4 pt-[calc(14px+var(--safe-top))]">
      <header className="flex items-start justify-between px-1">
        <div>
          <p className="label">{s.isToday ? 'сегодня' : 'день'} · {t.weekday}</p>
          <h1 className="font-display mt-1 text-[length:var(--text-display)] leading-none">{t.date}</h1>
        </div>
        <div className="flex items-center gap-1 pt-1">
          <button aria-label="Предыдущий день" onClick={() => router.push(`/?day=${prevDay}`)} className="press rounded-full px-3 py-2 font-mono text-ink-2">←</button>
          {!s.isToday && <button onClick={() => router.push('/')} className="press rounded-full border border-rule px-3 py-1.5 font-mono text-xs">сегодня</button>}
          {!s.isToday && <button aria-label="Следующий день" onClick={() => router.push(`/?day=${nextDay}`)} className="press rounded-full px-3 py-2 font-mono text-ink-2">→</button>}
        </div>
      </header>

      {s.challengeDay && s.challengeDay.n >= 1 && s.challengeDay.n <= s.challengeDay.of && (
        <p className="mt-3 px-1 font-mono text-xs text-ink-2">
          челлендж · день {s.challengeDay.n}/{s.challengeDay.of} <span className="text-ink-3">{'■'.repeat(s.challengeDay.n)}{'□'.repeat(Math.max(0, s.challengeDay.of - s.challengeDay.n))}</span>
        </p>
      )}

      <section aria-labelledby="hero-kcal" className="surface relative mt-4 overflow-hidden p-5">
        <div className="aura" aria-hidden />
        <div className="relative flex items-center gap-4">
          <PlateDots kcalShare={kcalShare} proteinShare={proteinShare} size={118} />
          <div className="min-w-0 flex-1">
            <p id="hero-kcal" className="label">ккал</p>
            <p className="tabular font-mono text-[length:var(--text-numeral)] font-medium leading-none tracking-tight" style={{ color: s.status?.kcal === 'over' ? 'var(--over)' : 'var(--ink)' }}>{fmt(s.totals.kcal)}</p>
            {g && <p className="mt-1 font-mono text-xs text-ink-2">цель {g.kcal_min}–{g.kcal_max}</p>}
          </div>
        </div>
        <div className="relative mt-4 space-y-3">
          <MacroRow name="белок" unit="г" value={s.totals.protein_g} min={g?.protein_min_g ?? 0} max={g?.protein_max_g ?? null} color="var(--protein)" big />
          {g && <AsciiBar value={s.totals.kcal} min={g.kcal_min} max={g.kcal_max} color="var(--kcal)" label="калории" width={26} />}
          <div className="grid grid-cols-2 gap-3 pt-1">
            <MacroRow name="жиры" unit="г" value={s.totals.fat_g} min={g?.fat_min_g ?? 0} max={g?.fat_max_g ?? null} color="var(--fat)" />
             <MacroRow name="углев" unit="г" value={s.totals.carbs_g} min={g?.carbs_min_g ?? 0} max={g?.carbs_max_g ?? null} color="var(--carbs)" />
          </div>
          {s.totals.macros_incomplete > 0 && (
            <p className="font-mono text-[11px] text-ink-3">* БЖУ неполные: у {s.totals.macros_incomplete} поз. известны только ккал</p>
          )}
        </div>
        {s.remaining && (
          <p className="relative mt-4 border-t border-dashed border-rule pt-3 text-sm text-ink-2">
            {s.remaining.protein_to_min > 0 ? <>Белка ещё <b className="text-protein">{s.remaining.protein_to_min} г</b></> : <>Белок добран <span className="font-mono text-ok">✓</span></>}
            <span className="text-ink-3"> · </span>
            {s.remaining.kcal_to_max >= 0 ? <>до потолка <b>{s.remaining.kcal_to_max} ккал</b></> : <span className="text-over">выше потолка на {-s.remaining.kcal_to_max} ккал</span>}
          </p>
        )}
      </section>

      <MealList meals={s.meals} timezone={s.profile.timezone} onChange={() => void revalidate()} onDelete={removeMeal} />
    </main>
  );
}

function MacroRow({ name, unit, value, min, max, color, big }: { name: string; unit: string; value: number; min: number; max: number | null; color: string; big?: boolean }) {
  return (
    <div className="min-w-0">
      <div className="flex items-baseline justify-between gap-1 whitespace-nowrap">
        <span className="label">{name}</span>
        <span className={`tabular font-mono ${big ? 'text-xl font-medium' : 'text-xs'}`}>
          <span style={{ color }} className={big ? '' : 'text-sm font-medium'}>{fmt(value)}</span>
          <span className="text-ink-3">/{min}{max ? `–${max}` : '+'}{big ? ` ${unit}` : ''}</span>
        </span>
      </div>
      <AsciiBar value={value} min={min} max={max} color={color} label={name} width={big ? 26 : 11} />
    </div>
  );
}

function withoutMeal(d: TodayResponse, id: string): TodayResponse {
  const m = d.summary.meals.find((x) => x.id === id);
  if (!m) return d;
  const t = d.summary.totals;
  return {
    ...d,
    summary: {
      ...d.summary,
      meals: d.summary.meals.filter((x) => x.id !== id),
      totals: { ...t, kcal: t.kcal - m.kcal, protein_g: t.protein_g - m.protein_g, fat_g: t.fat_g - m.fat_g, carbs_g: t.carbs_g - m.carbs_g, meals_count: t.meals_count - 1 },
    },
  };
}
