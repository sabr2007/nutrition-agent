import { z } from 'zod';
import { rateLimit } from '@/lib/ratelimit';
import { handler, HttpError, json, readJson, requireUser } from '@/lib/http';
import { after } from 'next/server';
import { runAgent } from '@/lib/agent/run';
import { maybeReviewMemory } from '@/lib/agent/memory-review';

export const maxDuration = 120;

export const GET = handler(async (req) => {
  const { userId, sb } = await requireUser(req);
  const before = new URL(req.url).searchParams.get('before');
  let q = sb.from('agent_messages').select('id, role, kind, text, meta, created_at').eq('user_id', userId).eq('thread', 'main')
    .order('created_at', { ascending: false }).limit(40);
  if (before) q = q.lt('created_at', before);
  const { data, error } = await q;
  if (error) throw new HttpError(500, 'Не удалось загрузить чат', 'db');
  return json({ messages: (data ?? []).reverse() });
});

const Body = z.object({ text: z.string().min(1).max(2000), skill: z.string().max(40).optional() });

export const POST = handler(async (req) => {
  const { userId, sb } = await requireUser(req);
  rateLimit(`chat:${userId}`, 30, 5 * 60_000);
  const parsed = Body.safeParse(await readJson(req));
  if (!parsed.success) throw new HttpError(400, 'Пустое сообщение', 'validation');
  const r = await runAgent({ sb, userId, trigger: 'chat', userText: parsed.data.text, skillKey: parsed.data.skill ?? null });
  // After the response is sent: periodic background memory review (proposals only).
  after(() => maybeReviewMemory(sb, userId).catch(() => 0));
  return json({
    reply: { id: r.messageId, role: 'assistant', kind: 'chat', text: r.text, created_at: new Date().toISOString(), meta: { choices: r.ui.choices ?? null, proposed_memories: r.ui.proposedMemories, pending_actions: r.ui.pendingActions, logged_meals: r.ui.loggedMeals, model: r.model } },
    decision: r.decision,
    tools: r.toolCalls.map((t) => t.tool),
    latencyMs: r.latencyMs,
  });
});
