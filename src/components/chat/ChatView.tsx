'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import useSWR from 'swr';
import { api, fetcher, refreshToday } from '@/lib/client/api';
import type { ChatMessage, ChatPart } from '@/lib/chat/protocol';
import type { TodayResponse } from '@/lib/client/types';
import { supabaseBrowser } from '@/lib/supabase/browser';
import { useSession } from '@/components/auth/AuthGate';
import { useToast } from '@/components/ui/Toast';
import { ChatDrawer } from './ChatDrawer';
import { ChatHeader } from './ChatHeader';
import { Composer, type OutgoingMessage } from './Composer';
import { MessageList } from './MessageList';
import { SKILLS } from './PlusMenu';
import { useChatStream } from './useChatStream';
import { useDeepMode } from './useDeepMode';
import { rememberPreview } from './useMediaUrls';
import { useViewportBox } from './useViewportBox';

type ChatPage = { messages: ChatMessage[] };

/** Same as the server page size: a full first page means there may be older messages. */
const PAGE = 40;

export function ChatView() {
  const session = useSession();
  const toast = useToast();
  const params = useSearchParams();
  const skillParam = params.get('skill');
  const { data, mutate } = useSWR<ChatPage>('/api/chat', fetcher);
  const { data: today } = useSWR<TodayResponse>('/api/today', fetcher);
  const [deep, toggleDeep] = useDeepMode();
  const [drawer, setDrawer] = useState(false);
  const [older, setOlder] = useState<ChatMessage[]>([]);
  // Replies that arrived in this session, shown until the refetched page includes them.
  const [settled, setSettled] = useState<ChatMessage[]>([]);
  const [olderDone, setOlderDone] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const startedSkill = useRef(false);
  useViewportBox(root);

  const stream = useChatStream({
    onDone: (user, reply) => {
      setSettled((xs) => [...xs, ...(user ? [user] : []), reply]);
      void refreshToday(); // the agent may have logged food or weight
      void mutate();
    },
    refetch: async () => (await mutate())?.messages,
  });

  const send = useCallback((m: OutgoingMessage) => {
    for (const a of m.attachments) rememberPreview(a.mediaId, a.previewUrl);
    const parts: ChatPart[] = [
      ...m.attachments.map((a) => ({ type: 'image' as const, media_id: a.mediaId, path: '' })),
      ...(m.text ? [{ type: 'text' as const, text: m.text }] : []),
    ];
    const user: ChatMessage = { id: null, role: 'user', kind: 'chat', text: m.text, parts, created_at: new Date().toISOString() };
    void stream.send({ text: m.text, mediaIds: m.attachments.map((a) => a.mediaId), skill: m.skill, deep }, user);
  }, [deep, stream]);

  // Deep links like /chat?skill=close_day (Today screen, reminders) start that skill once.
  useEffect(() => {
    if (!skillParam || startedSkill.current || !data) return;
    const s = SKILLS.find((x) => x.skill === skillParam);
    if (!s) return;
    startedSkill.current = true;
    send({ text: s.text, attachments: [], skill: s.skill });
  }, [skillParam, data, send]);

  const messages = dedupe([...older, ...(data?.messages ?? []), ...settled]);

  async function loadOlder() {
    const oldest = messages[0];
    if (!oldest) return;
    try {
      const page = await api<ChatPage>(`/api/chat?before=${encodeURIComponent(oldest.created_at)}`);
      setOlder((xs) => [...page.messages, ...xs]);
      if (page.messages.length < PAGE) setOlderDone(true);
    } catch (e) {
      toast({ text: (e as Error).message, tone: 'error' });
    }
  }

  async function memoryDecision(messageId: string | null, id: string, ok: boolean) {
    const sb = supabaseBrowser();
    const { error } = await sb.from('memories').update({ status: ok ? 'active' : 'rejected' }).eq('id', id);
    if (error) {
      toast({ text: 'Не получилось сохранить', tone: 'error' });
      return;
    }
    const msg = messages.find((m) => m.id === messageId);
    if (msg?.id && msg.meta) {
      const meta = { ...msg.meta, proposed_memories: (msg.meta.proposed_memories ?? []).map((p) => (p.id === id ? { ...p, status: ok ? 'active' : 'rejected' } : p)) };
      await sb.from('agent_messages').update({ meta }).eq('id', msg.id);
    }
    toast({ text: ok ? 'Запомнил' : 'Не буду запоминать' });
    void mutate();
  }

  async function confirmAction(messageId: string | null, actionId: string, decision: 'confirm' | 'cancel') {
    if (!messageId) return;
    try {
      const r = await api<{ text: string }>('/api/agent/confirm', { body: { message_id: messageId, action_id: actionId, decision } });
      toast({ text: r.text });
      void mutate();
      void refreshToday();
    } catch (e) {
      toast({ text: (e as Error).message, tone: 'error' });
    }
  }

  const canLoadOlder = !olderDone && (data?.messages.length ?? 0) >= PAGE;

  return (
    <div ref={root} data-keyboard="closed" className="group fixed inset-x-0 top-0 z-20 flex h-dvh flex-col">
      <ChatHeader today={today} onMenu={() => setDrawer(true)} />
      {!data ? (
        <div className="flex flex-1 items-center justify-center"><span className="ascii text-ink-3 blink">загрузка</span></div>
      ) : (
        <MessageList
          messages={messages}
          turn={stream.turn}
          header={canLoadOlder ? (
            <button type="button" onClick={() => void loadOlder()} className="press mx-auto rounded-full border border-rule px-3.5 py-1.5 font-mono text-xs text-ink-2">показать раньше</button>
          ) : null}
          empty={<EmptyState />}
          onChoice={(text) => send({ text, attachments: [] })}
          onMemory={(mid, id, ok) => void memoryDecision(mid, id, ok)}
          onConfirm={(mid, aid, d) => void confirmAction(mid, aid, d)}
          onRetry={stream.retry}
          onDismiss={stream.dismiss}
        />
      )}
      <div className="relative z-10 px-3 pb-[calc(10px+var(--safe-bottom))] pt-1 group-data-[keyboard=open]:pb-2">
        <div className="mx-auto max-w-md">
          <Composer userId={session?.user.id} busy={stream.busy} deep={deep} onToggleDeep={toggleDeep} onSend={send}
            showSuggestions={Boolean(data) && !messages.length && !stream.turn} />
        </div>
      </div>
      {drawer && <ChatDrawer onClose={() => setDrawer(false)} />}
    </div>
  );
}

/** Keeps the first copy of each saved message (by id); unsaved ones (no id) always stay. */
function dedupe(list: ChatMessage[]): ChatMessage[] {
  const seen = new Set<string>();
  return list.filter((m) => {
    if (!m.id) return true;
    if (seen.has(m.id)) return false;
    seen.add(m.id);
    return true;
  });
}

function EmptyState() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center px-6 text-center">
      <h1 className="font-display text-[length:var(--text-display)] leading-tight">Чем помочь?</h1>
      <p className="mt-3 max-w-[30ch] text-[15px] text-ink-2">Пиши, говори или присылай фото еды и этикеток. Я сам запишу в день и посчитаю.</p>
    </div>
  );
}
