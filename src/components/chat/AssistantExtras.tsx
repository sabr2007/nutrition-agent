'use client';

import Link from 'next/link';
import type { ChatMeta } from '@/lib/chat/protocol';
import { fmt } from '@/lib/client/format';

type Props = {
  meta: ChatMeta;
  isLast: boolean;
  onChoice: (text: string) => void;
  onMemory: (id: string, ok: boolean) => void;
  onConfirm: (actionId: string, decision: 'confirm' | 'cancel') => void;
};

/** What the agent wrote into the day (meal cards, chips) and the buttons it asked for. */
export function AssistantExtras({ meta, isLast, onChoice, onMemory, onConfirm }: Props) {
  const meals = meta.logged_meals ?? [];
  const actions = meta.actions ?? [];
  const memories = (meta.proposed_memories ?? []).filter((p) => !p.status);
  const pending = meta.pending_actions ?? [];
  return (
    <>
      {meals.length > 0 && (
        <ul className="mt-3 space-y-2" aria-label="Записано в дневник">
          {meals.map((m) => (
            <li key={m.id}>
              <Link href={`/log?edit=${m.id}`} className="press surface flex items-center gap-3 px-3.5 py-3">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-linen font-mono text-sm text-ok" aria-hidden>✓</span>
                <span className="min-w-0 flex-1">
                  <span className="label block">в дневнике</span>
                  <span className="block truncate text-[15px] font-medium">{m.title}</span>
                </span>
                <span className="tabular shrink-0 text-right font-mono text-xs leading-tight">
                  <span className="block text-[13px] font-medium">{fmt(m.kcal)} ккал</span>
                  <span className="text-protein">б {fmt(m.protein_g, 1)}</span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      {actions.length > 0 && (
        <ul className="mt-3 flex flex-wrap gap-1.5" aria-label="Что записано">
          {actions.map((a, i) => <li key={`${a.kind}-${i}`} className="rounded-full bg-chip px-3 py-1.5 text-[13px] leading-snug text-ink-2">{a.text}</li>)}
        </ul>
      )}
      {isLast && meta.choices && (
        <div className="mt-3 flex flex-wrap gap-2">
          {meta.choices.options.map((o) => (
            <button key={o} type="button" onClick={() => onChoice(o)} className="press rounded-full border border-ink/80 bg-card px-3.5 py-2 text-sm">{o}</button>
          ))}
        </div>
      )}
      {memories.map((p) => (
        <div key={p.id} className="surface mt-3 p-3.5 text-sm">
          <p className="label">запомнить?</p>
          <p className="mt-1">{p.content}</p>
          <div className="mt-2.5 flex gap-2">
            <button type="button" onClick={() => onMemory(p.id, true)} className="press rounded-full bg-ink px-3.5 py-1.5 text-xs text-linen">Да</button>
            <button type="button" onClick={() => onMemory(p.id, false)} className="press rounded-full border border-rule px-3.5 py-1.5 text-xs">Нет</button>
          </div>
        </div>
      ))}
      {pending.map((a) => (
        <div key={a.id} className="surface mt-3 border-warn/40 p-3.5 text-sm">
          <p className="label">нужно подтверждение</p>
          <p className="mt-1">{a.summary}</p>
          {a.status ? <p className="mt-2 font-mono text-xs text-ink-3">{a.status === 'confirm' ? 'подтверждено' : 'отменено'}</p> : (
            <div className="mt-2.5 flex gap-2">
              <button type="button" onClick={() => onConfirm(a.id, 'confirm')} className="press rounded-full bg-ink px-3.5 py-1.5 text-xs text-linen">Подтвердить</button>
              <button type="button" onClick={() => onConfirm(a.id, 'cancel')} className="press rounded-full border border-rule px-3.5 py-1.5 text-xs">Отмена</button>
            </div>
          )}
        </div>
      ))}
    </>
  );
}
