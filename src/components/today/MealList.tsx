'use client';

import { useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import type { DayMeal } from '@/lib/client/types';
import { api } from '@/lib/client/api';
import { fmt, hhmm } from '@/lib/client/format';
import { haptic } from '@/lib/client/telegram';
import { SLOT_LABELS } from '@/lib/nutrition/types';
import { Meter } from '@/components/ui/Ascii';
import { useToast } from '@/components/ui/Toast';

// The day's journal. A tap opens the meal; grams are edited in place (a new version of the meal
// through the same API — the old one stays in history), delete keeps history too. The bot's
// «✏️ Исправить» button opens the Mini App with ?meal=<id> right on that meal.

type Draft = Record<string, string>;

export function MealList({ meals, timezone, onChange, onDelete }: { meals: DayMeal[]; timezone: string; onChange: () => void; onDelete?: (id: string) => Promise<void> }) {
  const params = useSearchParams();
  const linked = params.get('meal');
  const [open, setOpen] = useState<string | null>(linked);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  useEffect(() => {
    if (linked && meals.some((m) => m.id === linked)) document.getElementById(`meal-${linked}`)?.scrollIntoView({ block: 'center' });
  }, [linked, meals]);

  async function remove(m: DayMeal) {
    setBusy(true);
    setOpen(null);
    try {
      if (onDelete) await onDelete(m.id);
      else { await api(`/api/meals/${m.id}`, { method: 'DELETE' }); onChange(); }
      haptic('warning');
      toast({ text: 'Удалено (история сохранена)' });
    } catch (e) {
      haptic('error');
      toast({ text: (e as Error).message, tone: 'error' });
    } finally {
      setBusy(false);
    }
  }

  async function saveGrams(m: DayMeal, d: Draft) {
    const items = m.items.map((i) => {
      const grams = Number((d[i.id] ?? String(i.grams)).replace(',', '.'));
      const g = Number.isFinite(grams) && grams >= 0 ? grams : i.grams;
      const base = { name: i.name, grams: g, source: 'user' as const, edited: g !== i.grams };
      if (i.food_id) return { ...base, food_id: i.food_id };
      // No food in the base (calories the person gave): keep its numbers per 100 g.
      const k = i.grams > 0 ? 100 / i.grams : 0;
      return { ...base, per100: { kcal: i.kcal * k, protein: i.protein_g * k, fat: i.fat_g * k, carbs: i.carbs_g * k, partial: i.partial } };
    });
    if (items.every((i, n) => i.grams === m.items[n].grams)) { setDraft(null); return; }
    setBusy(true);
    try {
      await api('/api/meals', { body: { supersedes_id: m.id, eaten_at: m.eaten_at, slot: m.slot, title: m.title, input_method: 'manual', items } });
      haptic('success');
      toast({ text: 'Сохранено (старая версия в истории)' });
      setDraft(null);
      onChange();
    } catch (e) {
      haptic('error');
      toast({ text: (e as Error).message, tone: 'error' });
    } finally {
      setBusy(false);
    }
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
          <p className="mt-2 text-sm">Пока ничего. Напиши боту, что съел, или пришли фото — запишу. Шаблоны в один тап — <span className="font-mono">/today</span>.</p>
        </div>
      )}
      <ol className="mt-2 space-y-2">
        {meals.map((m) => {
          const editing = open === m.id && draft != null;
          return (
            <li key={m.id} id={`meal-${m.id}`} className="surface overflow-hidden">
              <button onClick={() => { setOpen(open === m.id ? null : m.id); setDraft(null); haptic('selection'); }} aria-expanded={open === m.id} className="press flex w-full items-center gap-3 px-4 py-3 text-left">
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
                  <ul className="space-y-1.5 text-sm">
                    {m.items.map((i) => (
                      <li key={i.id} className="flex items-center justify-between gap-2">
                        <span className="min-w-0 flex-1 truncate">{i.name}</span>
                        {editing ? (
                          <label className="flex items-center gap-1 font-mono text-xs">
                            <input inputMode="decimal" aria-label={`Граммы: ${i.name}`} value={draft[i.id] ?? String(i.grams)}
                              onChange={(e) => setDraft({ ...draft, [i.id]: e.target.value })}
                              className="w-16 rounded-lg border border-rule bg-paper px-2 py-1 text-right" />
                            г
                          </label>
                        ) : (
                          <span className="tabular font-mono text-xs text-ink-2">{fmt(i.grams)} г · {fmt(i.kcal)}{i.partial ? ' · только ккал' : ` · б ${fmt(i.protein_g, 1)}`}</span>
                        )}
                      </li>
                    ))}
                  </ul>
                  {m.confidence != null && m.confidence < 0.99 && <p className="mt-2 text-xs text-ink-3">уверенность оценки <Meter value={m.confidence} /></p>}
                  <div className="mt-3 flex flex-wrap gap-2">
                    {editing ? (
                      <>
                        <button disabled={busy} onClick={() => saveGrams(m, draft)} className="press rounded-full bg-ink px-4 py-2 text-sm text-linen">Сохранить</button>
                        <button disabled={busy} onClick={() => setDraft(null)} className="press px-3 py-2 text-sm text-ink-3">Отмена</button>
                      </>
                    ) : (
                      <>
                        <button onClick={() => setDraft({})} className="press rounded-full border border-ink px-4 py-2 text-sm">Изменить граммы</button>
                        <button disabled={busy} onClick={() => remove(m)} className="press rounded-full px-4 py-2 text-sm text-over">Удалить</button>
                      </>
                    )}
                  </div>
                </div>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}

const METHOD: Record<string, string> = { photo: 'фото', voice: 'голос', text: 'текст', agent: 'чат', repeat: 'повтор', barcode: 'штрихкод', scale: 'весы', manual: 'вручную', template: 'шаблон' };
