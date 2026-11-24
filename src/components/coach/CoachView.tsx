'use client';

import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import useSWR from 'swr';
import { api, fetcher, refreshToday } from '@/lib/client/api';
import { supabaseBrowser } from '@/lib/supabase/browser';
import { useToast } from '@/components/ui/Toast';

type Meta = {
  choices?: { question: string; options: string[] } | null;
  proposed_memories?: { id: string; content: string; status?: string }[];
  pending_actions?: { id: string; kind: string; summary: string; status?: string }[];
  logged_meals?: { id: string; title: string; kcal: number; protein_g: number }[];
  model?: string;
};
type Msg = { id: string | null; role: 'user' | 'assistant'; kind: string; text: string; created_at: string; meta?: Meta };

const QUICK = [
  { label: 'Что съесть сейчас?', text: 'Что мне съесть сейчас, чтобы добрать белок?' },
  { label: 'Я сорвался', text: 'Я сорвался, давай разберём.' },
  { label: 'Закрыть день', text: 'Давай закроем день.', skill: 'close_day' },
  { label: 'План на завтра', text: 'Составь план питания на завтра.', skill: 'plan_tomorrow' },
  { label: 'Покупки на 3 дня', text: 'Список покупок на 3 дня.', skill: 'shopping_list' },
  { label: 'Разбор недели', text: 'Сделай разбор недели.', skill: 'weekly_review' },
  { label: 'Рецепт из курицы', text: 'Придумай бюджетный рецепт из курицы под мой остаток.', skill: 'recipe' },
];

export function CoachView() {
  const params = useSearchParams();
  const skillParam = params.get('skill');
  const { data, mutate } = useSWR<{ messages: Msg[] }>('/api/chat', fetcher);
  const [pending, setPending] = useState<Msg[]>([]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);
  const toast = useToast();
  const startedSkill = useRef(false);

  const messages = [...(data?.messages ?? []), ...pending];

  useEffect(() => { bottom.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages.length, busy]);

  async function send(t: string, skill?: string) {
    const body = t.trim();
    if (!body || busy) return;
    setText('');
    setBusy(true);
    setPending([{ id: null, role: 'user', kind: 'chat', text: body, created_at: new Date().toISOString() }]);
    try {
      const r = await api<{ reply: Msg }>('/api/chat', { body: { text: body, skill } });
      setPending((p) => [...p, r.reply]);
      void refreshToday(); // the agent may have logged a meal or ticked the checklist
      const fresh = await mutate();
      // keep the local copy if the server copy is not there (never lose a reply on screen)
      if (fresh?.messages.some((m) => m.id && m.id === r.reply.id)) setPending([]);
    } catch (e) {
      toast({ text: (e as Error).message, tone: 'error' });
      setPending([]);
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (skillParam && !startedSkill.current && data) {
      startedSkill.current = true;
      const q = QUICK.find((x) => x.skill === skillParam);
      if (q) void send(q.text, q.skill);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [skillParam, data]);

  async function memoryDecision(id: string, ok: boolean) {
    await supabaseBrowser().from('memories').update({ status: ok ? 'active' : 'rejected' }).eq('id', id);
    toast({ text: ok ? 'Запомнил' : 'Не буду запоминать' });
    mutate();
  }

  async function confirmAction(messageId: string | null, actionId: string, decision: 'confirm' | 'cancel') {
    if (!messageId) return;
    try {
      const r = await api<{ text: string }>('/api/agent/confirm', { body: { message_id: messageId, action_id: actionId, decision } });
      toast({ text: r.text });
      mutate();
      void refreshToday();
    } catch (e) {
      toast({ text: (e as Error).message, tone: 'error' });
    }
  }

  return (
    <main className="flex min-h-[calc(100dvh-var(--nav-h))] flex-col px-4 pt-[calc(14px+var(--safe-top))]">
      <header className="px-1">
        <p className="label">коуч · помнит контекст</p>
        <h1 className="font-display mt-1 text-[length:var(--text-display)] leading-none">Рядом</h1>
      </header>

      <div className="mt-4 flex-1 space-y-3 pb-40">
        {!messages.length && (
          <div className="surface framed p-5 text-sm text-ink-2">
            <p>Пиши как другу: «съел плов у друзей», «что съесть, если осталось 70 г белка», «я на парах до 16:00». Я сам посмотрю день, запишу и посчитаю.</p>
          </div>
        )}
        {messages.map((m, i) => (
          <Bubble key={m.id ?? `p${i}`} m={m}
            onChoice={(o) => send(o)}
            onMemory={memoryDecision}
            onConfirm={(aid, d) => confirmAction(m.id, aid, d)}
            isLast={i === messages.length - 1} />
        ))}
        {busy && <p className="px-2 font-mono text-xs text-ink-3 blink">смотрю данные и думаю</p>}
        <div ref={bottom} />
      </div>

      <div className="fixed inset-x-0 bottom-[calc(var(--nav-h)+var(--safe-bottom)+8px)] z-20">
        <div className="mx-auto max-w-md px-4">
          <div className="no-scrollbar mb-2 flex gap-2 overflow-x-auto">
            {QUICK.map((q) => (
              <button key={q.label} onClick={() => send(q.text, q.skill)} disabled={busy} className="press shrink-0 rounded-full border border-rule bg-card/90 px-3 py-1.5 text-xs backdrop-blur disabled:opacity-50">{q.label}</button>
            ))}
          </div>
          <form onSubmit={(e) => { e.preventDefault(); void send(text); }} className="flex items-end gap-2 rounded-[22px] border border-rule bg-card/95 p-2 shadow-[var(--shadow-card)] backdrop-blur">
            <textarea value={text} onChange={(e) => setText(e.target.value)} rows={1} placeholder="Напиши коучу…" aria-label="Сообщение коучу"
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(text); } }}
              className="max-h-32 min-h-[44px] flex-1 resize-none bg-transparent px-2 py-2.5 outline-none" />
            <button disabled={busy || !text.trim()} className="press rounded-full bg-ink px-4 py-2.5 text-sm text-linen disabled:opacity-40">→</button>
          </form>
        </div>
      </div>
    </main>
  );
}

function Bubble({ m, onChoice, onMemory, onConfirm, isLast }: { m: Msg; onChoice: (o: string) => void; onMemory: (id: string, ok: boolean) => void; onConfirm: (actionId: string, d: 'confirm' | 'cancel') => void; isLast: boolean }) {
  const mine = m.role === 'user';
  const meta = m.meta ?? {};
  return (
    <div className={`fade-in flex ${mine ? 'justify-end' : 'justify-start'}`}>
      <div className={`max-w-[88%] ${mine ? 'rounded-[20px] rounded-br-md bg-ink px-4 py-2.5 text-linen' : 'surface rounded-[20px] rounded-bl-md px-4 py-3'}`}>
        {m.kind === 'proactive' && <p className="label mb-1">сам написал</p>}
        <div className="whitespace-pre-wrap text-[15px] leading-relaxed">{renderText(m.text)}</div>
        {!!meta.logged_meals?.length && (
          <ul className="mt-2 space-y-1 border-t border-dashed border-rule pt-2 font-mono text-xs text-ink-2">
            {meta.logged_meals.map((x) => <li key={x.id}>+ {x.title} · {x.kcal} ккал · б {x.protein_g}</li>)}
          </ul>
        )}
        {isLast && meta.choices && (
          <div className="mt-3">
            <div className="flex flex-wrap gap-2">
              {meta.choices.options.map((o) => <button key={o} onClick={() => onChoice(o)} className="press rounded-full border border-ink px-3 py-1.5 text-sm">{o}</button>)}
            </div>
          </div>
        )}
        {meta.proposed_memories?.filter((p) => !p.status).map((p) => (
          <div key={p.id} className="mt-3 rounded-xl bg-linen p-3 text-sm">
            <p className="label">запомнить?</p>
            <p className="mt-1">{p.content}</p>
            <div className="mt-2 flex gap-2">
              <button onClick={() => onMemory(p.id, true)} className="press rounded-full bg-ink px-3 py-1.5 text-xs text-linen">Да</button>
              <button onClick={() => onMemory(p.id, false)} className="press rounded-full border border-rule px-3 py-1.5 text-xs">Нет</button>
            </div>
          </div>
        ))}
        {meta.pending_actions?.map((a) => (
          <div key={a.id} className="mt-3 rounded-xl border border-warn/40 bg-linen p-3 text-sm">
            <p className="label">нужно подтверждение</p>
            <p className="mt-1">{a.summary}</p>
            {a.status ? <p className="mt-2 font-mono text-xs text-ink-3">{a.status === 'confirm' ? 'подтверждено' : 'отменено'}</p> : (
              <div className="mt-2 flex gap-2">
                <button onClick={() => onConfirm(a.id, 'confirm')} className="press rounded-full bg-ink px-3 py-1.5 text-xs text-linen">Подтвердить</button>
                <button onClick={() => onConfirm(a.id, 'cancel')} className="press rounded-full border border-rule px-3 py-1.5 text-xs">Отмена</button>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

/** Minimal markdown: **bold** and list bullets; no HTML injection (React escapes text). */
function renderText(t: string) {
  return t.split('\n').map((line, i) => {
    const parts = line.split(/(\*\*[^*]+\*\*)/g).map((p, j) => (p.startsWith('**') && p.endsWith('**') ? <b key={j}>{p.slice(2, -2)}</b> : <span key={j}>{p.replace(/^[-*] /, '· ')}</span>));
    return <span key={i} className="block">{parts}</span>;
  });
}
