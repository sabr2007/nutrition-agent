'use client';

import { useState } from 'react';
import Link from 'next/link';
import type { DayMeal } from '@/lib/client/types';
import { api } from '@/lib/client/api';
import { fmt, hhmm } from '@/lib/client/format';
import { SLOT_LABELS } from '@/lib/nutrition/types';
import { Meter } from '@/components/ui/Ascii';
import { useToast } from '@/components/ui/Toast';

export function MealList({ meals, timezone, onChange }: { meals: DayMeal[]; timezone: string; onChange: () => void }) {
  const [open, setOpen] = useState<string | null>(null);
  const toast = useToast();

  async function remove(m: DayMeal) {
    await api(`/api/meals/${m.id}`, { method: 'DELETE' });
    toast({ text: 'Удалено (история сохранена)' });
    setOpen(null);
    onChange();
  }
  async function repeat(m: DayMeal) {
    await api(`/api/meals/${m.id}/repeat`, { body: {} });
    toast({ text: `Повторил: ${m.title ?? 'приём'}` });
    onChange();
  }

  return (
    <section aria-labelledby="meals-h" className="mt-6">
      <div className="flex items-baseline justify-between px-1">
        <h2 id="meals-h" className="font-display text-xl">Журнал</h2>
        <span className="font-mono text-xs text-ink-3">{meals.length ? `${meals.length} зап.` : 'пусто'}</span>
      </div>
      {!meals.length && (
        <div className="surface mt-2 p-5 text-center text-ink-2">
          <pre className="ascii text-ink-3" aria-hidden>{'┌──────────┐\n│  · · ·   │\n└──────────┘'}</pre>
          <p className="mt-2 text-sm">Пока ничего. Нажми <b>+</b> — шаблон записывается в один тап.</p>
        </div>
      )}
      <ol className="mt-2 space-y-2">
        {meals.map((m) => (
          <li key={m.id} className="surface overflow-hidden">
            <button onClick={() => setOpen(open === m.id ? null : m.id)} aria-expanded={open === m.id} className="press flex w-full items-center gap-3 px-4 py-3 text-left">
              <span className="w-11 shrink-0 font-mono text-sm text-ink-2">{hhmm(m.eaten_at, timezone)}</span>
              <span className="min-w-0 flex-1">
                <span className="block truncate">{m.title ?? SLOT_LABELS[m.slot ?? ''] ?? 'Приём'}</span>
                <span className="font-mono text-xs text-ink-3">{SLOT_LABELS[m.slot ?? ''] ?? ''}{m.input_method !== 'template' ? ` · ${METHOD[m.input_method] ?? m.input_method}` : ''}</span>
              </span>
              <span className="text-right">
                <span className="tabular block font-mono text-sm">{fmt(m.kcal)}</span>
                <span className="tabular font-mono text-xs text-protein">б {fmt(m.protein_g)}</span>
              </span>
            </button>
            {open === m.id && (
              <div className="fade-in border-t border-dashed border-rule px-4 pb-4 pt-3">
                <ul className="space-y-1 text-sm">
                  {m.items.map((i) => (
                    <li key={i.id} className="flex items-baseline justify-between gap-2">
                      <span className="min-w-0 flex-1 truncate">{i.name}</span>
                      <span className="tabular font-mono text-xs text-ink-2">{fmt(i.grams)} г · {fmt(i.kcal)} · б {fmt(i.protein_g, 1)}</span>
                    </li>
                  ))}
                </ul>
                {m.confidence != null && m.confidence < 0.99 && <p className="mt-2 text-xs text-ink-3">уверенность оценки <Meter value={m.confidence} /></p>}
                <div className="mt-3 flex flex-wrap gap-2">
                  <Link href={`/log?edit=${m.id}`} className="press rounded-full border border-ink px-4 py-2 text-sm">Изменить</Link>
                  <button onClick={() => repeat(m)} className="press rounded-full border border-rule px-4 py-2 text-sm">Повторить сейчас</button>
                  <button onClick={() => remove(m)} className="press rounded-full px-4 py-2 text-sm text-over">Удалить</button>
                </div>
              </div>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}

const METHOD: Record<string, string> = { photo: 'фото', voice: 'голос', text: 'текст', agent: 'чат', repeat: 'повтор', barcode: 'штрихкод', scale: 'весы', manual: 'вручную' };
