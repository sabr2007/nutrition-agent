'use client';

import { useState } from 'react';
import type { ChecklistRow } from '@/lib/client/types';
import { supabaseBrowser } from '@/lib/supabase/browser';
import { useSession } from '@/components/auth/AuthGate';
import { useToast } from '@/components/ui/Toast';

export function Checklist({ day, items, onChange }: { day: string; items: ChecklistRow[]; onChange: () => void }) {
  const session = useSession();
  const toast = useToast();
  const [optimistic, setOptimistic] = useState<Record<string, boolean>>({});
  const [editing, setEditing] = useState<string | null>(null);
  const [num, setNum] = useState('');
  const done = items.filter((i) => optimistic[i.key] ?? i.done).length;

  async function mark(key: string, value: boolean, numeric: number | null = null) {
    setOptimistic((o) => ({ ...o, [key]: value }));
    const { error } = await supabaseBrowser().from('checklist_marks').insert({ user_id: session!.user.id, local_day: day, item_key: key, done: value, value: numeric, source: 'user' });
    if (error) {
      setOptimistic((o) => { const n = { ...o }; delete n[key]; return n; });
      toast({ text: 'Не сохранилось, попробуй ещё раз', tone: 'error' });
    }
    onChange();
  }

  return (
    <section aria-labelledby="checklist-h" className="mt-6">
      <div className="flex items-baseline justify-between px-1">
        <h2 id="checklist-h" className="font-display text-xl">Чек-лист</h2>
        <span className="font-mono text-xs text-ink-3">{done}/{items.length}</span>
      </div>
      <ul className="surface mt-2 divide-y divide-dashed divide-rule overflow-hidden">
        {items.map((it) => {
          const isDone = optimistic[it.key] ?? it.done;
          if (it.kind === 'number') {
            return (
              <li key={it.key} className="flex min-h-[52px] items-center gap-3 px-4">
                <span className="font-mono text-sm" aria-hidden>{isDone ? '[x]' : '[ ]'}</span>
                <span className="flex-1">{it.label}</span>
                {editing === it.key ? (
                  <form onSubmit={(e) => { e.preventDefault(); const v = Number(num.replace(',', '.')); if (Number.isFinite(v)) void mark(it.key, it.target ? v >= it.target : true, v); setEditing(null); }} className="flex items-center gap-2">
                    <input autoFocus inputMode="decimal" value={num} onChange={(e) => setNum(e.target.value)} className="w-24 rounded-lg border border-rule bg-paper px-2 py-1.5 text-right font-mono" aria-label={it.label} />
                    <button className="press rounded-full bg-ink px-3 py-1.5 text-sm text-linen">ок</button>
                  </form>
                ) : (
                  <button onClick={() => { setEditing(it.key); setNum(it.value != null ? String(it.value) : ''); }} className="press rounded-full border border-rule px-3 py-1.5 font-mono text-sm">
                    {it.value != null ? `${it.value.toLocaleString('ru-RU')} ${it.unit ?? ''}` : `цель ${it.target?.toLocaleString('ru-RU') ?? ''} ${it.unit ?? ''}`}
                  </button>
                )}
              </li>
            );
          }
          return (
            <li key={it.key}>
              <button onClick={() => mark(it.key, !isDone)} aria-pressed={isDone}
                className="press flex min-h-[52px] w-full items-center gap-3 px-4 text-left">
                <span className={`font-mono text-sm ${isDone ? 'text-ok' : 'text-ink-3'}`} aria-hidden>{isDone ? '[x]' : '[ ]'}</span>
                <span className={`flex-1 ${isDone ? 'text-ink-3 line-through decoration-rule-strong' : ''}`}>{it.label}</span>
                {it.due_time && <span className="font-mono text-xs text-ink-3">{it.due_time}</span>}
                {it.source === 'auto' && isDone && <span className="label">авто</span>}
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
