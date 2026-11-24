import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import { after } from 'next/server';
import { rateLimit } from '@/lib/ratelimit';
import { handler, HttpError, json, readJson, requireUser } from '@/lib/http';
import { runAgent, type AgentImage, type AgentResult } from '@/lib/agent/run';
import { maybeReviewMemory } from '@/lib/agent/memory-review';
import { encodeEvent, type ChatEvent, type ChatMessage, type ChatPart } from '@/lib/chat/protocol';

// «Думать дольше» runs can take minutes on the stronger model.
export const maxDuration = 300;

const PAGE = 40;
const MAX_PHOTOS = 4;
const MAX_TEXT = 2000;

export const GET = handler(async (req) => {
  const { userId, sb } = await requireUser(req);
  const before = new URL(req.url).searchParams.get('before');
  let q = sb.from('agent_messages').select('id, role, kind, text, parts, meta, created_at').eq('user_id', userId).eq('thread', 'main')
    .order('created_at', { ascending: false }).limit(PAGE);
  if (before) q = q.lt('created_at', before);
  const { data, error } = await q;
  if (error) throw new HttpError(500, 'Не удалось загрузить чат', 'db');
  return json({ messages: (data ?? []).reverse() });
});

const Body = z.object({
  text: z.string().max(MAX_TEXT).default(''),
  media_ids: z.array(z.string().uuid()).max(MAX_PHOTOS).default([]),
  skill: z.string().max(40).optional(),
  deep: z.boolean().optional(),
}).refine((b) => b.text.trim().length > 0 || b.media_ids.length > 0, { message: 'Пустое сообщение' });

/** Downloads the attached photos (own media only), keeping the order they were attached in. */
async function loadImages(sb: SupabaseClient, userId: string, ids: string[]): Promise<AgentImage[]> {
  if (!ids.length) return [];
  const { data, error } = await sb.from('media').select('id, bucket, path, mime').in('id', ids).eq('user_id', userId).eq('kind', 'photo');
  if (error || (data ?? []).length !== new Set(ids).size) throw new HttpError(404, 'Фото не найдено', 'not_found');
  const byId = new Map((data ?? []).map((m) => [m.id as string, m]));
  return Promise.all(ids.map(async (id) => {
    const m = byId.get(id)!;
    const { data: blob, error: dErr } = await sb.storage.from(m.bucket as string).download(m.path as string);
    if (dErr || !blob) throw new HttpError(404, 'Не удалось прочитать фото', 'storage');
    return { mediaId: id, path: m.path as string, data: new Uint8Array(await blob.arrayBuffer()), mime: (m.mime as string) || 'image/jpeg' };
  }));
}

function replyMessage(r: AgentResult, deep: boolean): ChatMessage {
  return {
    id: r.messageId, role: 'assistant', kind: 'chat', text: r.text, created_at: new Date().toISOString(),
    meta: {
      choices: r.ui.choices ?? null, proposed_memories: r.ui.proposedMemories, pending_actions: r.ui.pendingActions,
      logged_meals: r.ui.loggedMeals, actions: r.ui.actions, model: r.model ?? undefined, deep,
    },
  };
}

function userMessage(r: AgentResult, text: string, images: AgentImage[]): ChatMessage {
  const parts: ChatPart[] = [
    ...images.map((i) => ({ type: 'image' as const, media_id: i.mediaId, path: i.path })),
    ...(text ? [{ type: 'text' as const, text }] : []),
  ];
  return { id: r.userMessageId, role: 'user', kind: 'chat', text, parts, created_at: new Date().toISOString() };
}

/**
 * Runs the agent and streams newline-delimited JSON events: tool activity, text deltas, then
 * the saved messages (or an error the UI shows next to the unsent message).
 */
export const POST = handler(async (req) => {
  const { userId, sb } = await requireUser(req);
  rateLimit(`chat:${userId}`, 30, 5 * 60_000);
  const parsed = Body.safeParse(await readJson(req));
  if (!parsed.success) throw new HttpError(400, parsed.error.issues[0]?.message ?? 'Пустое сообщение', 'validation');
  const text = parsed.data.text.trim();
  const deep = Boolean(parsed.data.deep);
  const images = await loadImages(sb, userId, parsed.data.media_ids);

  const encoder = new TextEncoder();
  let push: (e: ChatEvent) => void = () => undefined;
  const run = runAgent({
    sb, userId, trigger: 'chat', userText: text, images, deep, skillKey: parsed.data.skill ?? null,
    onEvent: (e) => push(e),
  });
  // The turn must finish (and be saved) even if the app is closed mid-answer.
  after(async () => {
    await run.catch(() => null);
    await maybeReviewMemory(sb, userId).catch(() => 0);
  });

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let open = true;
      push = (e) => {
        if (!open) return;
        try {
          controller.enqueue(encoder.encode(encodeEvent(e)));
        } catch {
          open = false; // the client went away; the run continues in after()
        }
      };
      try {
        const r = await run;
        push(r.decision === 'error' ? { t: 'error', message: r.text } : { t: 'done', message: replyMessage(r, deep), user: userMessage(r, text, images) });
      } catch {
        push({ t: 'error', message: 'Что-то пошло не так. Попробуй ещё раз.' });
      } finally {
        open = false;
        try { controller.close(); } catch { /* already closed */ }
      }
    },
  });
  return new Response(stream, {
    headers: { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store, no-transform', 'X-Accel-Buffering': 'no' },
  });
});
