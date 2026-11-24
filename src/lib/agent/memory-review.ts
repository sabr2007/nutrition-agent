import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { genObject } from '@/lib/llm/generate';

// Background memory review (Hermes lesson): every N user messages a cheap model reads the
// recent conversation and proposes at most two durable facts. It may only ADD proposals —
// the user confirms or rejects them on the Memory screen. Grounded facts only.
const EVERY_N_USER_MESSAGES = 8;

const Proposal = z.object({
  facts: z.array(z.object({
    content: z.string().describe('Короткий устойчивый факт от третьего лица: «По вторникам пары до 16:00»'),
    kind: z.enum(['fact', 'preference', 'pattern', 'routine']),
    evidence: z.string().describe('Цитата/пересказ из переписки, на чём основан факт'),
  })).describe('0–2 факта; пусто, если нет устойчивых фактов'),
});

export async function maybeReviewMemory(sb: SupabaseClient, userId: string): Promise<number> {
  const { data: prof } = await sb.from('profiles').select('settings').eq('user_id', userId).single();
  const settings = (prof?.settings ?? {}) as { last_memory_review_at?: string };
  const since = settings.last_memory_review_at ?? '1970-01-01T00:00:00Z';
  const { count } = await sb.from('agent_messages').select('id', { count: 'exact', head: true }).eq('user_id', userId).eq('role', 'user').gt('created_at', since);
  if ((count ?? 0) < EVERY_N_USER_MESSAGES) return 0;

  const [{ data: msgs }, { data: mems }] = await Promise.all([
    sb.from('agent_messages').select('role, text, created_at').eq('user_id', userId).gt('created_at', since).order('created_at').limit(60),
    sb.from('memories').select('content').eq('user_id', userId).in('status', ['active', 'proposed', 'rejected']).limit(80),
  ]);
  const transcript = (msgs ?? []).map((m) => `${m.role === 'user' ? 'Он' : 'Коуч'}: ${String(m.text).slice(0, 400)}`).join('\n');
  const known = (mems ?? []).map((m) => `- ${m.content}`).join('\n');
  try {
    const res = await genObject({
      task: 'compose',
      log: { userId, purpose: 'memory_review' },
      system: 'Ты просматриваешь переписку коуча по питанию с человеком и выбираешь устойчивые факты для долгой памяти: распорядок (пары, смены, сон), предпочтения и ограничения в еде, повторяющиеся паттерны срывов и то, что помогает. НЕ сохраняй разовые события, цифры дня, догадки о здоровье и диагнозы. Только то, что прямо сказано. Не повторяй уже известное. Максимум 2 факта, можно 0.',
      messages: [{ role: 'user', content: `Уже известно:\n${known || '- ничего'}\n\nПереписка:\n${transcript}` }],
      schema: Proposal,
      temperature: 0.1,
      maxOutputTokens: 800,
    });
    const fresh = res.result.facts.filter((f) => f.content.length > 8 && !(mems ?? []).some((m) => m.content === f.content)).slice(0, 2);
    if (fresh.length) {
      await sb.from('memories').insert(fresh.map((f) => ({ user_id: userId, kind: f.kind, content: f.content, tags: ['review'], importance: 3, status: 'proposed', source: 'agent' })));
    }
    return fresh.length;
  } finally {
    await sb.from('profiles').update({ settings: { ...settings, last_memory_review_at: new Date().toISOString() } }).eq('user_id', userId);
  }
}
