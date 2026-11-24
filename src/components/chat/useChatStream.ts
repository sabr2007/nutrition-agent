'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { accessToken, supabaseBrowser } from '@/lib/supabase/browser';
import { parseEvents, type ChatMessage } from '@/lib/chat/protocol';

export type SendPayload = { text: string; mediaIds: string[]; skill?: string; deep: boolean };

/** The message being answered right now (or the one that failed and can be retried). */
export type PendingTurn = {
  key: string;
  payload: SendPayload;
  user: ChatMessage;
  status: 'streaming' | 'failed';
  /** Reply text streamed so far. */
  text: string;
  /** What the agent is doing right now, e.g. «Записываю приём». */
  tool: string | null;
  error: string | null;
};

type Callbacks = {
  /**
   * The saved user message and reply arrived: put them into the chat. Called synchronously right
   * before the pending turn is cleared, so React renders the swap in one frame (no duplicate).
   */
  onDone: (user: ChatMessage | null, reply: ChatMessage) => void;
  /** Re-read the chat from the server (after a dropped connection). */
  refetch: () => Promise<ChatMessage[] | undefined>;
};

const RECOVERY_TRIES = 3;
const RECOVERY_STEP_MS = 4000;
const CLOCK_SKEW_MS = 60_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Sends a chat message and reads the NDJSON stream from /api/chat. */
export function useChatStream(callbacks: Callbacks) {
  const [turn, setTurn] = useState<PendingTurn | null>(null);
  const cb = useRef(callbacks);
  useEffect(() => { cb.current = callbacks; }, [callbacks]);

  const run = useCallback(async (payload: SendPayload, user: ChatMessage) => {
    const key = crypto.randomUUID();
    const sentAt = Date.now();
    setTurn({ key, payload, user, status: 'streaming', text: '', tool: null, error: null });
    const update = (fn: (t: PendingTurn) => PendingTurn) => setTurn((t) => (t && t.key === key ? fn(t) : t));
    const fail = (error: string) => update((t) => ({ ...t, status: 'failed', error, tool: null }));
    const finish = () => setTurn((t) => (t && t.key === key ? null : t));

    let res: Response;
    try {
      const token = await accessToken();
      res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ text: payload.text, media_ids: payload.mediaIds, skill: payload.skill, deep: payload.deep }),
      });
    } catch {
      fail('Нет связи. Сообщение не отправлено.');
      return;
    }
    if (!res.ok || !res.body) {
      const data = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
      if (res.status === 401) await supabaseBrowser().auth.signOut().catch(() => undefined);
      fail(data.error?.message ?? 'Не получилось отправить.');
      return;
    }

    try {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parsed = parseEvents(buffer);
        buffer = parsed.rest;
        for (const e of parsed.events) {
          if (e.t === 'text') update((t) => ({ ...t, text: t.text + e.d, tool: null }));
          else if (e.t === 'tool') update((t) => ({ ...t, tool: e.label, text: '' }));
          else if (e.t === 'error') {
            void reader.cancel().catch(() => undefined);
            fail(e.message);
            return;
          } else if (e.t === 'done') {
            void reader.cancel().catch(() => undefined);
            cb.current.onDone(e.user, e.message);
            finish();
            return;
          }
        }
      }
      throw new Error('stream ended early');
    } catch {
      // The connection dropped mid-answer. The server finishes and saves the turn anyway,
      // so look for it before offering a retry (a retry would duplicate the message).
      for (let i = 0; i < RECOVERY_TRIES; i++) {
        await sleep(RECOVERY_STEP_MS);
        const fresh = await cb.current.refetch().catch(() => undefined);
        const delivered = fresh?.some((m) => m.role === 'user' && m.text === payload.text && Date.parse(m.created_at) >= sentAt - CLOCK_SKEW_MS);
        const answered = delivered && fresh?.some((m) => m.role === 'assistant' && Date.parse(m.created_at) >= sentAt - CLOCK_SKEW_MS);
        if (answered) {
          finish();
          return;
        }
      }
      fail('Связь оборвалась. Если ответ не появился — повтори.');
    }
  }, []);

  const send = useCallback((payload: SendPayload, user: ChatMessage) => run(payload, user), [run]);

  const retry = useCallback(() => {
    if (turn?.status === 'failed') void run(turn.payload, turn.user);
  }, [run, turn]);

  const dismiss = useCallback(() => setTurn((t) => (t?.status === 'failed' ? null : t)), []);

  return { turn, busy: turn?.status === 'streaming', send, retry, dismiss };
}
