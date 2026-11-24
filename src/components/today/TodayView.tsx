'use client';

import Link from 'next/link';
import { useSearchParams, useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import useSWR from 'swr';
import { api, fetcher, newClientId, postOrQueue } from '@/lib/client/api';
import type { TodayResponse, TemplateLite } from '@/lib/client/types';
import { dayTitle, fmt } from '@/lib/client/format';
import { addDays, dayClockMin, localParts } from '@/lib/nutrition/day';
import { AsciiBar } from '@/components/ui/Ascii';
import { PlateDots } from '@/components/ui/PlateDots';
import { useToast } from '@/components/ui/Toast';
import { Checklist } from './Checklist';
import { MealList } from './MealList';
import { CoachCard } from './CoachCard';
import { PushPrompt } from './PushPrompt';

export function TodayView() {
  const params = useSearchParams();
  const router = useRouter();
  const day = params.get('day');
  const notifId = params.get('n');
  const key = `/api/today${day ? `?day=${day}` : ''}`;
  const { data, error, mutate, isLoading } = useSWR<TodayResponse>(key, fetcher, { revalidateOnFocus: true, refreshInterval: 60_000 });
  const toast = useToast();

  // Opened from a push notification → record the reaction.
  useEffect(() => {
    if (!notifId) return;
    api(`/api/notifications/${notifId}`, { body: { action: 'opened' } }).catch(() => undefined);
  }, [notifId]);

  const s = data?.summary;
  const next = useMemo(() => (data ? nextTemplate(data) : null), [data]);

  async function logTemplate(t: TemplateLite) {
    const clientId = newClientId('tpl');
    const res = await postOrQueue<{ meal: { id: string; kcal: number; protein_g: number } }>('/api/meals/template', { template_id: t.id, client_id: clientId });
    if (res.queued) toast({ text: `Нет сети — «${t.name}» запишется позже` });
    else {
      const id = res.data!.meal.id;
      toast({ text: `${t.name} · ${Math.round(res.data!.meal.kcal)} ккал`, action: { label: 'отменить', onClick: () => void api(`/api/meals/${id}`, { method: 'DELETE' }).then(() => mutate()) } });
    }
    mutate();
  }

  if (error && !data) {
    return <div className="p-6"><p className="label">ошибка</p><p className="mt-2 text-ink-2">{(error as Error).message}</p><button className="press mt-4 rounded-full border border-ink px-4 py-2" onClick={() => mutate()}>Повторить</button></div>;
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
        </div>
        {s.remaining && (
          <p className="relative mt-4 border-t border-dashed border-rule pt-3 text-sm text-ink-2">
            {s.remaining.protein_to_min > 0 ? <>Белка ещё <b className="text-protein">{s.remaining.protein_to_min} г</b></> : <>Белок добран <span className="font-mono text-ok">✓</span></>}
            <span className="text-ink-3"> · </span>
            {s.remaining.kcal_to_max >= 0 ? <>до потолка <b>{s.remaining.kcal_to_max} ккал</b></> : <span className="text-over">выше потолка на {-s.remaining.kcal_to_max} ккал</span>}
          </p>
        )}
      </section>

      {s.isToday && next && (
        <section className="mt-4">
          <button onClick={() => logTemplate(next)} className="press surface flex w-full items-center gap-3 p-4 text-left">
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-linen font-mono text-lg">{next.glyph ?? '+'}</span>
            <span className="min-w-0 flex-1">
              <span className="label">по плану · {next.default_time}</span>
              <span className="block truncate font-medium">{next.name}</span>
              <span className="font-mono text-xs text-ink-3">{next.kcal} ккал · б {fmt(next.protein_g)} г</span>
            </span>
            <span className="rounded-full bg-ink px-4 py-2 text-sm text-linen">записать</span>
          </button>
        </section>
      )}

      {s.isToday && isLate(s.profile.timezone) && !s.checklist.find((c) => c.key === 'close_day')?.done && (
        <Link href="/chat?skill=close_day" className="press surface framed mt-4 flex items-center justify-between p-4">
          <span><span className="label">вечер</span><span className="block font-medium">Закрыть день — 30 секунд</span></span>
          <span className="font-mono text-ink-2">→</span>
        </Link>
      )}
      <CoachCard coach={data!.coach} notification={data!.notification} onChange={() => mutate()} />
      <PushPrompt />

      <Checklist day={s.day} items={s.checklist} onChange={() => mutate()} />
      <MealList meals={s.meals} timezone={s.profile.timezone} onChange={() => mutate()} />

      <div className="mt-6 flex justify-center">
        <Link href="/log" className="press font-mono text-sm text-ink-2 underline decoration-dotted underline-offset-4">+ записать задним числом</Link>
      </div>
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

function isLate(tz: string): boolean {
  const h = localParts(new Date(), tz).hour;
  return h >= 23 || h < 4;
}

function nextTemplate(data: TodayResponse): TemplateLite | null {
  const s = data.summary;
  const tz = s.profile.timezone;
  const nowMin = dayClockMin(localParts(new Date(), tz).hhmm, s.profile.day_boundary_minutes);
  const done = new Set(s.checklist.filter((c) => c.done).map((c) => c.key));
  const loggedTemplates = new Set(s.meals.map((m) => m.template_id).filter(Boolean));
  const candidates = data.templates
    .filter((t) => t.default_time && (!t.training_day_only || s.trainingDay))
    .filter((t) => !loggedTemplates.has(t.id) && !(t.checklist_key && done.has(t.checklist_key)))
    .map((t) => ({ t, at: dayClockMin(t.default_time!, s.profile.day_boundary_minutes) }))
    .sort((a, b) => a.at - b.at);
  // the closest one that is due within the next 90 minutes or overdue
  const due = candidates.filter((c) => c.at <= nowMin + 90);
  return (due[due.length - 1] ?? candidates[0])?.t ?? null;
}
