'use client';

import Link from 'next/link';
import useSWR from 'swr';
import { fetcher } from '@/lib/client/api';
import { AsciiBar } from '@/components/ui/Ascii';
import { dayTitle, fmt } from '@/lib/client/format';

type DayTarget = { kcal_min: number; kcal_max: number; protein_min_g: number; protein_max_g: number | null };
type Trends = { per_day: { day: string; meals: number; kcal: number; protein_g: number; in_plan: boolean | null; protein_hit: boolean | null; target: DayTarget | null }[] };

/** Bar scale: a bit above the goal corridor (or the value itself when there is no goal). */
function scaleFor(value: number, top: number | null | undefined): number {
  return Math.max(value, (top ?? value) * 1.45, 1);
}

export default function HistoryPage() {
  const { data } = useSWR<Trends>('/api/report?days=30', fetcher);
  const days = [...(data?.per_day ?? [])].reverse();
  return (
    <main className="px-4 pt-[calc(14px+var(--safe-top))]">
      <header className="px-1">
        <p className="label">история · 30 дней</p>
        <h1 className="font-display mt-1 text-[length:var(--text-display)] leading-none">Дни</h1>
      </header>
      <ul className="mt-4 space-y-2">
        {days.map((d) => {
          const t = dayTitle(d.day);
          return (
            <li key={d.day}>
              <Link href={`/?day=${d.day}`} className="press surface block p-4">
                <div className="flex items-baseline justify-between">
                  <span className="font-medium">{t.date} <span className="text-sm text-ink-3">{t.weekday}</span></span>
                  <span className="font-mono text-xs">{d.in_plan ? <span className="text-ok">[в плане]</span> : d.in_plan === false ? <span className="text-ink-3">[вне плана]</span> : ''}</span>
                </div>
                <div className="mt-2 flex items-center justify-between gap-3 font-mono text-xs">
                  <AsciiBar value={d.kcal} min={d.target?.kcal_min ?? 0} max={d.target?.kcal_max ?? null} scaleMax={scaleFor(d.kcal, d.target?.kcal_max)} width={18} color="var(--kcal)" label="ккал" />
                  <span className="tabular">{fmt(d.kcal)} ккал</span>
                </div>
                <div className="mt-1 flex items-center justify-between gap-3 font-mono text-xs">
                  <AsciiBar value={d.protein_g} min={d.target?.protein_min_g ?? 0} max={d.target?.protein_max_g ?? null} scaleMax={scaleFor(d.protein_g, d.target?.protein_max_g ?? d.target?.protein_min_g)} width={18} color="var(--protein)" label="белок" />
                  <span className="tabular text-protein">б {fmt(d.protein_g)}</span>
                </div>
              </Link>
            </li>
          );
        })}
        {!days.length && <li className="surface p-6 text-center text-sm text-ink-3">Здесь появятся дни с записями.</li>}
      </ul>
    </main>
  );
}
