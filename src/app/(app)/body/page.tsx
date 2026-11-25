'use client';

import { useState } from 'react';
import useSWR from 'swr';
import { fetcher, refreshToday } from '@/lib/client/api';
import { supabaseBrowser } from '@/lib/supabase/browser';
import { useSession } from '@/components/auth/AuthGate';
import { Sparkline } from '@/components/ui/Ascii';
import { useToast } from '@/components/ui/Toast';
import { fmt } from '@/lib/client/format';

type Trends = { weight: { points: { day: string; kg: number; avg7: number | null }[]; avg7_change_kg: number | null }; waist_cm: { day: string; cm: number }[] };

export default function BodyPage() {
  const session = useSession();
  const toast = useToast();
  const { data, mutate } = useSWR<Trends>('/api/report?days=30', fetcher);
  const [weight, setWeight] = useState('');
  const [waist, setWaist] = useState('');
  const [busy, setBusy] = useState(false);

  const points = data?.weight.points ?? [];
  const last = points[points.length - 1];

  async function save(kind: 'weight' | 'waist', raw: string) {
    const value = Number(raw.replace(',', '.'));
    if (!Number.isFinite(value) || value <= 0) return;
    setBusy(true);
    const sb = supabaseBrowser();
    const { error } = await sb.from('body_metrics').insert({ user_id: session!.user.id, kind, value, unit: kind === 'weight' ? 'kg' : 'cm', fasted: kind === 'weight' ? true : null });
    setBusy(false);
    if (error) toast({ text: 'Не сохранилось', tone: 'error' });
    else { toast({ text: kind === 'weight' ? `Вес ${value} кг записан` : `Талия ${value} см записана` }); kind === 'weight' ? setWeight('') : setWaist(''); mutate(); void refreshToday(); }
  }

  return (
    <main className="px-4 pt-[calc(14px+var(--safe-top))]">
      <header className="px-1">
        <p className="label">тело · смотрим на среднее за 7 дней</p>
        <h1 className="font-display mt-1 text-[length:var(--text-display)] leading-none">Замеры</h1>
      </header>

      <section className="surface relative mt-4 overflow-hidden p-5">
        <div className="aura opacity-50" aria-hidden />
        <div className="relative flex items-end justify-between">
          <div>
            <p className="label">среднее 7 дней</p>
            <p className="tabular font-mono text-[length:var(--text-numeral)] font-medium leading-none">{last?.avg7 != null ? fmt(last.avg7, 1) : '—'}<span className="text-lg text-ink-3"> кг</span></p>
          </div>
          {data?.weight.avg7_change_kg != null && (
            <p className={`font-mono text-sm ${data.weight.avg7_change_kg <= 0 ? 'text-ok' : 'text-warn'}`}>{data.weight.avg7_change_kg > 0 ? '+' : ''}{fmt(data.weight.avg7_change_kg, 2)} кг / 30 дн</p>
          )}
        </div>
        <div className="relative mt-4">
          <Sparkline values={points.map((p) => p.avg7)} label="среднее за 7 дней" color="var(--ink)" />
          <div className="mt-1"><Sparkline values={points.map((p) => p.kg)} label="вес по дням" color="var(--ink-3)" /></div>
          <p className="mt-2 font-mono text-[11px] text-ink-3">верх — среднее 7д, низ — ежедневный вес. Колебания на 0.5–1.5 кг за день — вода, это нормально.</p>
        </div>
      </section>

      <form onSubmit={(e) => { e.preventDefault(); void save('weight', weight); }} className="surface mt-4 flex items-center gap-3 p-4">
        <label className="flex-1">
          <span className="label">вес натощак, кг</span>
          <input inputMode="decimal" value={weight} onChange={(e) => setWeight(e.target.value)} placeholder={last ? String(last.kg) : '0.0'} className="tabular mt-1 w-full bg-transparent font-mono text-3xl outline-none" />
        </label>
        <button disabled={busy || !weight} className="press rounded-full bg-ink px-5 py-3 text-linen disabled:opacity-40">Записать</button>
      </form>

      <form onSubmit={(e) => { e.preventDefault(); void save('waist', waist); }} className="surface mt-3 flex items-center gap-3 p-4">
        <label className="flex-1">
          <span className="label">талия на уровне пупка, см</span>
          <input inputMode="decimal" value={waist} onChange={(e) => setWaist(e.target.value)} placeholder={data?.waist_cm.at(-1) ? String(data.waist_cm.at(-1)!.cm) : '0'} className="tabular mt-1 w-full bg-transparent font-mono text-2xl outline-none" />
        </label>
        <button disabled={busy || !waist} className="press rounded-full border border-ink px-5 py-3 disabled:opacity-40">Записать</button>
      </form>
      <p className="mt-2 px-1 text-xs text-ink-3">Талию мерь раз в неделю, утром натощак, в одной и той же точке.</p>

      <section className="mt-6">
        <h2 className="px-1 font-display text-xl">История</h2>
        <ul className="surface mt-2 divide-y divide-dashed divide-rule">
          {[...points].reverse().slice(0, 14).map((p) => (
            <li key={p.day} className="flex items-center justify-between px-4 py-2.5 font-mono text-sm">
              <span className="text-ink-2">{p.day.slice(5).split('-').reverse().join('.')}</span>
              <span className="tabular">{fmt(p.kg, 1)} кг</span>
              <span className="tabular text-ink-3">ср {p.avg7 != null ? fmt(p.avg7, 1) : '—'}</span>
            </li>
          ))}
          {data?.waist_cm.slice(-5).reverse().map((w) => (
            <li key={`w${w.day}`} className="flex items-center justify-between px-4 py-2.5 font-mono text-sm">
              <span className="text-ink-2">{w.day.slice(5).split('-').reverse().join('.')}</span>
              <span className="tabular">талия {fmt(w.cm, 1)} см</span>
              <span />
            </li>
          ))}
          {!points.length && !data?.waist_cm.length && <li className="px-4 py-6 text-center text-sm text-ink-3">Запиши первый вес — завтра утром натощак.</li>}
        </ul>
      </section>
    </main>
  );
}
