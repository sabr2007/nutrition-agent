'use client';

import { useState } from 'react';
import useSWR from 'swr';
import { supabaseBrowser } from '@/lib/supabase/browser';
import { useSession } from '@/components/auth/AuthGate';
import { useToast } from '@/components/ui/Toast';

type Memory = { id: string; kind: string; content: string; status: string; pinned: boolean; importance: number; source: string; ref_day: string | null; created_at: string };
type Skill = { id: string; key: string; version: number; title: string; description: string; body: string; user_id: string | null; usage_count: number; created_by: string };

const KIND: Record<string, string> = { fact: 'факт', preference: 'предпочтение', pattern: 'паттерн', routine: 'распорядок', episode: 'эпизод', day_summary: 'итог дня', week_summary: 'итог недели' };

export default function MemoryPage() {
  const session = useSession();
  const toast = useToast();
  const [tab, setTab] = useState<'memory' | 'skills'>('memory');
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [adding, setAdding] = useState('');
  const { data: memories, mutate } = useSWR<Memory[]>('memories', async () => {
    const { data } = await supabaseBrowser().from('memories').select('id, kind, content, status, pinned, importance, source, ref_day, created_at').in('status', ['active', 'proposed']).order('pinned', { ascending: false }).order('created_at', { ascending: false }).limit(200);
    return (data ?? []) as Memory[];
  });
  const { data: skills } = useSWR<Skill[]>('skills', async () => {
    const { data } = await supabaseBrowser().from('skills').select('id, key, version, title, description, body, user_id, usage_count, created_by').eq('is_current', true).order('key');
    return (data ?? []) as Skill[];
  });

  const update = async (id: string, patch: Partial<Memory>) => {
    const { error } = await supabaseBrowser().from('memories').update(patch).eq('id', id);
    if (error) toast({ text: 'Не сохранилось', tone: 'error' });
    mutate();
  };

  const proposed = (memories ?? []).filter((m) => m.status === 'proposed');
  const active = (memories ?? []).filter((m) => m.status === 'active');

  return (
    <main className="px-4 pt-[calc(14px+var(--safe-top))]">
      <header className="px-1">
        <p className="label">что агент помнит между сессиями</p>
        <h1 className="font-display mt-1 text-[length:var(--text-display)] leading-none">Память</h1>
      </header>
      <div className="mt-4 flex gap-2" role="tablist">
        {(['memory', 'skills'] as const).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)} className={`press rounded-full border px-4 py-1.5 text-sm ${tab === t ? 'border-ink bg-ink text-linen' : 'border-rule'}`}>{t === 'memory' ? 'Факты' : 'Навыки'}</button>
        ))}
      </div>

      {tab === 'memory' ? (
        <>
          {proposed.length > 0 && (
            <section className="mt-4">
              <p className="label px-1">агент предлагает запомнить</p>
              <ul className="mt-2 space-y-2">
                {proposed.map((m) => (
                  <li key={m.id} className="surface framed p-4">
                    <p>{m.content}</p>
                    <div className="mt-3 flex gap-2">
                      <button onClick={() => update(m.id, { status: 'active' })} className="press rounded-full bg-ink px-4 py-1.5 text-sm text-linen">Запомнить</button>
                      <button onClick={() => update(m.id, { status: 'rejected' })} className="press rounded-full border border-rule px-4 py-1.5 text-sm">Нет</button>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          )}
          <form onSubmit={async (e) => { e.preventDefault(); if (!adding.trim()) return; await supabaseBrowser().from('memories').insert({ user_id: session!.user.id, kind: 'fact', content: adding.trim(), status: 'active', source: 'user', pinned: true, importance: 4 }); setAdding(''); mutate(); }} className="surface mt-4 flex gap-2 p-2">
            <input value={adding} onChange={(e) => setAdding(e.target.value)} placeholder="Добавить факт: «по вторникам пары до 14:00»" className="flex-1 bg-transparent px-2 py-2 outline-none" aria-label="Новый факт" />
            <button className="press rounded-full bg-ink px-4 text-sm text-linen">+</button>
          </form>
          <ul className="mt-3 space-y-2 pb-6">
            {active.map((m) => (
              <li key={m.id} className="surface p-4">
                <div className="flex items-center justify-between">
                  <span className="label">{KIND[m.kind] ?? m.kind}{m.ref_day ? ` · ${m.ref_day}` : ''}{m.source === 'agent' ? ' · от агента' : ''}</span>
                  <button onClick={() => update(m.id, { pinned: !m.pinned })} className="press font-mono text-xs text-ink-3" aria-pressed={m.pinned}>{m.pinned ? '● закреплено' : '○ закрепить'}</button>
                </div>
                {editing === m.id ? (
                  <form onSubmit={async (e) => { e.preventDefault(); await update(m.id, { content: draft }); setEditing(null); }} className="mt-2">
                    <textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={3} className="w-full rounded-xl border border-rule bg-paper p-2" />
                    <div className="mt-2 flex gap-2"><button className="press rounded-full bg-ink px-4 py-1.5 text-sm text-linen">Сохранить</button><button type="button" onClick={() => setEditing(null)} className="press px-3 text-sm text-ink-3">Отмена</button></div>
                  </form>
                ) : (
                  <p className="mt-1">{m.content}</p>
                )}
                {editing !== m.id && (
                  <div className="mt-2 flex gap-3 font-mono text-xs text-ink-3">
                    <button onClick={() => { setEditing(m.id); setDraft(m.content); }} className="press">править</button>
                    <button onClick={() => update(m.id, { status: 'archived' })} className="press">в архив</button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </>
      ) : (
        <ul className="mt-4 space-y-2 pb-6">
          {(skills ?? []).map((s) => (
            <li key={s.id} className="surface p-4">
              <details>
                <summary className="cursor-pointer list-none">
                  <span className="flex items-baseline justify-between">
                    <span className="font-medium">{s.title}</span>
                    <span className="font-mono text-xs text-ink-3">{s.key} · v{s.version}{s.user_id ? ' · личный' : ''}</span>
                  </span>
                  <span className="mt-1 block text-sm text-ink-2">{s.description}</span>
                </summary>
                <pre className="mt-3 whitespace-pre-wrap rounded-xl bg-paper p-3 font-mono text-xs leading-relaxed text-ink-2">{s.body.trim()}</pre>
              </details>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
