'use client';

import { useMemo, useState } from 'react';
import { itemFromFood, sumMacros, withGrams } from '@/lib/nutrition/calc';
import type { Food } from '@/lib/nutrition/types';
import { SLOT_LABELS } from '@/lib/nutrition/types';
import type { Draft, DraftItem } from '@/lib/client/draft';
import { supabaseBrowser } from '@/lib/supabase/browser';
import { fmt } from '@/lib/client/format';
import { Meter } from '@/components/ui/Ascii';
import { FoodSearch } from './FoodSearch';

type Props = {
  draft: Draft;
  slot: string;
  onSlot: (s: string) => void;
  timeLabel: string;
  saving: boolean;
  onSave: (d: Draft, opts: { isLabeled: boolean }) => void;
  onCancel: () => void;
};

const SLOTS = ['breakfast', 'snack', 'shake', 'lunch', 'dinner', 'late', 'supplement'];

export function ConfirmView({ draft: initial, slot, onSlot, timeLabel, saving, onSave, onCancel }: Props) {
  const [draft, setDraft] = useState<Draft>(initial);
  const [answered, setAnswered] = useState<Record<string, string>>({});
  const [search, setSearch] = useState<{ replaceKey?: string; initial?: string } | null>(null);
  const [isLabeled, setIsLabeled] = useState(false);
  const totals = useMemo(() => sumMacros(draft.items), [draft.items]);
  const rangeLow = draft.items.reduce((a, i) => a + (i.kcal_range?.[0] ?? i.kcal), 0);
  const rangeHigh = draft.items.reduce((a, i) => a + (i.kcal_range?.[1] ?? i.kcal), 0);

  const setItems = (fn: (items: DraftItem[]) => DraftItem[]) => setDraft((d) => ({ ...d, items: fn(d.items) }));

  function changeGrams(key: string, grams: number) {
    setItems((items) => items.map((it) => (it.key === key ? { ...it, ...withGrams(it, Math.max(0, grams)) } : it)));
  }

  function replaceFood(key: string | undefined, food: Food) {
    if (!key) {
      const grams = Number(food.default_portion_g ?? 100);
      setItems((items) => [...items, { ...itemFromFood(food, grams, { source: 'user' }), key: `u${Date.now()}` }]);
      return;
    }
    setItems((items) => items.map((it) => {
      if (it.key !== key) return it;
      const next = itemFromFood(food, it.grams, { source: it.source === 'model' ? 'model' : 'user', confidence: it.confidence, model_grams: it.model_grams, model_label: it.model_label ?? it.label, edited: true });
      return { ...it, ...next, unmatched: false, key: it.key };
    }));
  }

  async function applyAnswer(qid: string, optIndex: number) {
    const q = draft.questions.find((x) => x.id === qid);
    const opt = q?.options[optIndex];
    if (!q || !opt) return;
    setAnswered((a) => ({ ...a, [qid]: opt.label }));
    if (opt.effect === 'set_grams' && opt.item_index != null && opt.grams != null) {
      const target = draft.items[opt.item_index];
      if (target) changeGrams(target.key, opt.grams);
    } else if (opt.effect === 'remove_item' && opt.item_index != null) {
      const target = draft.items[opt.item_index];
      if (target) setItems((items) => items.filter((i) => i.key !== target.key));
    } else if (opt.effect === 'add_item' && opt.food_query) {
      const { data } = await supabaseBrowser().rpc('search_foods', { q: opt.food_query, lim: 1 });
      const food = (data as Food[] | null)?.[0];
      if (food) setItems((items) => [...items, { ...itemFromFood(food, opt.grams ?? Number(food.default_portion_g ?? 10), { source: 'user', confidence: 0.8 }), key: `a${Date.now()}` }]);
    }
  }

  const hasUnmatched = draft.items.some((i) => i.unmatched || !i.per100);

  return (
    <div className="pb-[calc(140px+var(--safe-bottom))]">
      {draft.photoUrl && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={draft.photoUrl} alt="Фото приёма" className="surface mb-3 h-44 w-full object-cover" width={640} height={352} />
      )}
      {draft.transcript && <p className="mb-3 rounded-xl bg-card/70 px-3 py-2 text-sm text-ink-2">«{draft.transcript}»</p>}

      <div className="flex items-center justify-between px-1">
        <p className="label">проверь · {timeLabel}</p>
        {draft.confidence != null && <span className="text-xs text-ink-3">оценка <Meter value={draft.confidence} /></span>}
      </div>

      {draft.questions.filter((q) => !answered[q.id]).length > 0 && (
        <div className="mt-3 space-y-3">
          {draft.questions.filter((q) => !answered[q.id]).map((q) => (
            <div key={q.id} className="surface framed fade-in p-4">
              <p className="font-medium">{q.text}</p>
              <div className="mt-3 flex flex-wrap gap-2">
                {q.options.map((o, i) => (
                  <button key={i} onClick={() => applyAnswer(q.id, i)} className="press rounded-full border border-ink px-4 py-2 text-sm">{o.label}</button>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      <ul className="mt-3 space-y-2">
        {draft.items.map((it) => (
          <li key={it.key} className="surface p-3">
            <div className="flex items-start gap-2">
              <button onClick={() => setSearch({ replaceKey: it.key, initial: it.food_query ?? it.name })} className="press min-w-0 flex-1 text-left">
                <span className={`block ${it.unmatched ? 'text-over' : ''}`}>{it.unmatched ? `«${it.label ?? it.name}» — выбери продукт` : it.name}</span>
                <span className="font-mono text-xs text-ink-3">
                  {it.per100 ? `${fmt(it.kcal)} ккал · б ${fmt(it.protein_g, 1)} · ж ${fmt(it.fat_g, 1)} · у ${fmt(it.carbs_g, 1)}` : 'нет данных о калорийности'}
                </span>
              </button>
              <button aria-label={`Убрать ${it.name}`} onClick={() => setItems((items) => items.filter((x) => x.key !== it.key))} className="press px-2 font-mono text-ink-3">×</button>
            </div>
            <div className="mt-2 flex items-center gap-2">
              <button aria-label="Меньше на 10 г" onClick={() => changeGrams(it.key, it.grams - (it.grams > 60 ? 10 : 5))} className="press h-11 w-11 rounded-full border border-rule font-mono text-lg">−</button>
              <label className="flex items-baseline gap-1 rounded-xl border border-rule bg-paper px-3 py-2">
                <input inputMode="decimal" value={String(it.grams)} onChange={(e) => { const v = Number(e.target.value.replace(',', '.')); if (Number.isFinite(v)) changeGrams(it.key, v); }}
                  className="tabular w-16 bg-transparent text-right font-mono text-lg outline-none" aria-label={`Граммы: ${it.name}`} />
                <span className="text-sm text-ink-3">г</span>
              </label>
              <button aria-label="Больше на 10 г" onClick={() => changeGrams(it.key, it.grams + (it.grams >= 60 ? 10 : 5))} className="press h-11 w-11 rounded-full border border-rule font-mono text-lg">+</button>
              <span className="ml-auto text-right">
                {it.confidence != null && it.source !== 'template' && <Meter value={it.confidence} />}
                {it.grams_low != null && it.grams_high != null && it.grams_high > it.grams_low && (
                  <span className="block font-mono text-[11px] text-ink-3">≈ {Math.round(it.grams_low)}–{Math.round(it.grams_high)} г</span>
                )}
              </span>
            </div>
            {it.kcal_range && <p className="mt-1 font-mono text-[11px] text-warn">честный разброс по составу: {it.kcal_range[0]}–{it.kcal_range[1]} ккал</p>}
          </li>
        ))}
      </ul>

      <button onClick={() => setSearch({})} className="press mt-3 w-full rounded-[var(--radius)] border border-dashed border-rule-strong py-3 text-sm text-ink-2">+ добавить продукт</button>

      <div className="mt-4 flex flex-wrap gap-2" role="radiogroup" aria-label="Приём пищи">
        {SLOTS.map((s) => (
          <button key={s} role="radio" aria-checked={slot === s} onClick={() => onSlot(s)} className={`press rounded-full border px-3 py-1.5 text-sm ${slot === s ? 'border-ink bg-ink text-linen' : 'border-rule'}`}>{SLOT_LABELS[s]}</button>
        ))}
      </div>

      <label className="mt-4 flex items-start gap-3 px-1 text-sm text-ink-2">
        <input type="checkbox" checked={isLabeled} onChange={(e) => setIsLabeled(e.target.checked)} className="mt-1 h-5 w-5 accent-[var(--ink)]" />
        <span><b className="text-ink">Размеченный приём</b> — граммы точные, с кухонных весов. Попадёт в датасет для оценки точности фото.</span>
      </label>

      <div className="fixed inset-x-0 bottom-0 z-30 border-t border-rule bg-linen/95 backdrop-blur-md">
        <div className="mx-auto flex max-w-md items-center gap-3 px-4 pb-[calc(12px+var(--safe-bottom))] pt-3">
          <div className="min-w-0 flex-1">
            <p className="tabular font-mono text-xl font-medium leading-none">{fmt(totals.kcal)} <span className="text-sm text-ink-3">ккал</span></p>
            <p className="tabular mt-1 font-mono text-xs text-ink-2">б {fmt(totals.protein_g)} · ж {fmt(totals.fat_g)} · у {fmt(totals.carbs_g)}{rangeHigh - rangeLow > 30 ? ` · ≈${Math.round(rangeLow)}–${Math.round(rangeHigh)}` : ''}</p>
          </div>
          <button onClick={onCancel} className="press rounded-full px-3 py-3 text-sm text-ink-2">Отмена</button>
          <button disabled={saving || !draft.items.length || hasUnmatched} onClick={() => onSave(draft, { isLabeled })}
            className="press rounded-full bg-ink px-6 py-3.5 font-medium text-linen disabled:opacity-40">
            {saving ? 'Сохраняю…' : 'Сохранить'}
          </button>
        </div>
      </div>

      {search && (
        <FoodSearch initial={search.initial} onClose={() => setSearch(null)} onPick={(f) => { replaceFood(search.replaceKey, f); setSearch(null); }} />
      )}
    </div>
  );
}
