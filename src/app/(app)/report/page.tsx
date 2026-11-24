'use client';

import Link from 'next/link';
import useSWR from 'swr';
import { fetcher } from '@/lib/client/api';
import { Sparkline } from '@/components/ui/Ascii';
import { fmt } from '@/lib/client/format';

type Trends = {
  range: [string, string]; days_with_data: number; days_in_plan: number; protein_hit_days: number; days_logged_3plus_meals: number;
  avg_kcal: number | null; avg_protein_g: number | null;
  per_day: { day: string; kcal: number; protein_g: number; in_plan: boolean | null }[];
  weight: { points: { day: string; kg: number; avg7: number | null }[]; avg7_change_kg: number | null };
  waist_cm: { day: string; cm: number }[];
  slips: { count: number; by_trigger: Record<string, number> };
};

const TRIGGERS: Record<string, string> = { hunger: 'голод', stress: 'стресс', social: 'компания', tired: 'усталость', boredom: 'скука', craving: 'тяга', other: 'другое' };

export default function ReportPage() {
  const { data } = useSWR<Trends>('/api/report?days=7', fetcher);
  if (!data) return <div className="p-6"><span className="ascii text-ink-3 blink">считаю</span></div>;
  const pct = (n: number) => (data.days_with_data ? Math.round((n / 7) * 100) : 0);
  const triggers = Object.entries(data.slips.by_trigger).sort((a, b) => b[1] - a[1]);
  return (
    <main className="px-4 pt-[calc(14px+var(--safe-top))]">
      <header className="px-1">
        <p className="label">неделя · {data.range[0].slice(5)} — {data.range[1].slice(5)}</p>
        <h1 className="font-display mt-1 text-[length:var(--text-display)] leading-none">Отчёт</h1>
      </header>
      <section className="mt-4 grid grid-cols-2 gap-2">
        <Stat label="дней в плане" value={`${data.days_in_plan}/7`} hint={`${pct(data.days_in_plan)}%`} />
        <Stat label="белок добран" value={`${data.protein_hit_days}/7`} hint="дней" />
        <Stat label="среднее ккал" value={fmt(data.avg_kcal)} hint="в день" />
        <Stat label="среднее белка" value={`${fmt(data.avg_protein_g)} г`} hint="в день" />
        <Stat label="вес, среднее 7д" value={data.weight.avg7_change_kg != null ? `${data.weight.avg7_change_kg > 0 ? '+' : ''}${fmt(data.weight.avg7_change_kg, 2)} кг` : '—'} hint="за неделю" />
        <Stat label="записано (3+ приёма)" value={`${data.days_logged_3plus_meals}/7`} hint="дней" />
      </section>
      <section className="surface mt-3 p-4">
        <p className="label">белок по дням</p>
        <div className="mt-2"><Sparkline values={data.per_day.map((d) => d.protein_g)} label="белок по дням" color="var(--protein)" /></div>
        <p className="label mt-3">ккал по дням</p>
        <div className="mt-2"><Sparkline values={data.per_day.map((d) => d.kcal)} label="калории по дням" color="var(--kcal)" /></div>
      </section>
      <section className="surface mt-3 p-4">
        <p className="label">срывы · {data.slips.count}</p>
        {triggers.length ? (
          <ul className="mt-2 space-y-1 font-mono text-sm">
            {triggers.map(([t, n]) => <li key={t} className="flex justify-between"><span>{TRIGGERS[t] ?? t}</span><span>{'■'.repeat(n)} {n}</span></li>)}
          </ul>
        ) : <p className="mt-2 text-sm text-ink-2">Срывов не записано.</p>}
      </section>
      <Link href="/chat?skill=weekly_review" className="press mt-4 flex justify-center rounded-full bg-ink py-4 text-linen">Разобрать неделю в чате</Link>
    </main>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="surface p-4">
      <p className="label">{label}</p>
      <p className="tabular mt-1 font-mono text-2xl font-medium">{value}</p>
      <p className="text-xs text-ink-3">{hint}</p>
    </div>
  );
}
