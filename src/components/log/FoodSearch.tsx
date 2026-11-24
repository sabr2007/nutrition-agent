'use client';

import { useEffect, useRef, useState } from 'react';
import { supabaseBrowser } from '@/lib/supabase/browser';
import type { Food } from '@/lib/nutrition/types';
import { LabelForm } from './LabelForm';

type Props = { initial?: string; onPick: (food: Food) => void; onClose: () => void };

/** Bottom sheet: fuzzy search in the food DB (+ create a personal food from a label). */
export function FoodSearch({ initial = '', onPick, onClose }: Props) {
  const [q, setQ] = useState(initial);
  const [results, setResults] = useState<Food[]>([]);
  const [creating, setCreating] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    if (q.trim().length < 2) { setResults([]); return; }
    timer.current = setTimeout(async () => {
      const { data } = await supabaseBrowser().rpc('search_foods', { q, lim: 12 });
      setResults((data ?? []) as Food[]);
    }, 160);
  }, [q]);

  return (
    <div className="fixed inset-0 z-40 flex flex-col bg-ink/30 backdrop-blur-[2px]" role="dialog" aria-modal="true" aria-label="Поиск продукта">
      <button className="flex-1" aria-label="Закрыть" onClick={onClose} />
      <div className="sheet-enter max-h-[82dvh] overflow-hidden rounded-t-[var(--radius-lg)] bg-linen pb-[var(--safe-bottom)] shadow-[var(--shadow-float)]">
        <div className="flex items-center gap-2 border-b border-rule p-4">
          <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="грудка, гречка, творог…" className="flex-1 rounded-full border border-rule bg-card px-4 py-3 outline-none focus:border-ink" aria-label="Поиск продукта" />
          <button onClick={onClose} className="press px-2 font-mono text-ink-2">esc</button>
        </div>
        <div className="max-h-[60dvh] overflow-y-auto">
          {!creating && (
            <ul className="divide-y divide-dashed divide-rule">
              {results.map((f) => (
                <li key={f.id}>
                  <button onClick={() => onPick(f)} className="press flex w-full items-baseline gap-3 px-4 py-3 text-left">
                    <span className="min-w-0 flex-1">
                      <span className="block">{f.name_ru}</span>
                      <span className="font-mono text-xs text-ink-3">{STATE[f.state]}{f.user_id ? ' · мой' : ''}{f.confidence !== 'high' ? ` · ${f.confidence === 'low' ? '≈ грубо' : '≈'}` : ''}</span>
                    </span>
                    <span className="tabular shrink-0 font-mono text-xs text-ink-2">{Math.round(Number(f.kcal_100g))} ккал · б {Number(f.protein_100g)}</span>
                  </button>
                </li>
              ))}
              {q.trim().length >= 2 && !results.length && <li className="px-4 py-6 text-center text-sm text-ink-3">Не нашёл. Сфоткай этикетку — добавлю как свой продукт.</li>}
            </ul>
          )}
          {creating ? (
            <LabelForm initialName={q} onCreated={({ food }) => onPick(food)} />
          ) : (
            <div className="p-4">
              <button onClick={() => setCreating(true)} className="press w-full rounded-full border border-dashed border-rule-strong py-3 text-sm text-ink-2">▤ свой продукт по этикетке — фото или вручную</button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

const STATE: Record<string, string> = { raw: 'сырой', cooked: 'готовый', dry: 'сухой', as_is: 'как есть' };
