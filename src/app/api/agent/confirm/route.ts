import { z } from 'zod';
import { handler, HttpError, json, readJson, requireUser } from '@/lib/http';

// Executes a dangerous action the agent proposed, only after the user pressed the button.
const Body = z.object({ message_id: z.string().uuid(), action_id: z.string().uuid(), decision: z.enum(['confirm', 'cancel']) });

export const POST = handler(async (req) => {
  const { userId, sb } = await requireUser(req);
  const parsed = Body.safeParse(await readJson(req));
  if (!parsed.success) throw new HttpError(400, 'Некорректный запрос', 'validation');
  const { data: msg } = await sb.from('agent_messages').select('id, meta').eq('id', parsed.data.message_id).eq('user_id', userId).single();
  const meta = (msg?.meta ?? {}) as { pending_actions?: { id: string; kind: string; params: Record<string, unknown>; status?: string; summary: string }[] };
  const action = meta.pending_actions?.find((a) => a.id === parsed.data.action_id);
  if (!action) throw new HttpError(404, 'Действие не найдено', 'not_found');
  if (action.status) throw new HttpError(409, 'Уже обработано', 'done');
  let resultText = 'Отменено.';
  if (parsed.data.decision === 'confirm') {
    if (action.kind === 'delete_meal') {
      const { error } = await sb.rpc('delete_meal', { p_id: action.params.meal_id as string });
      if (error) throw new HttpError(400, 'Не удалось удалить', 'db');
      resultText = 'Удалил. История сохранена.';
    } else if (action.kind === 'update_goal') {
      const { data: g } = await sb.from('goals').select('*').eq('id', action.params.goal_id as string).eq('user_id', userId).eq('is_current', true).single();
      if (!g) throw new HttpError(404, 'Цель не найдена', 'not_found');
      const { id: _id, created_at: _c, supersedes_id: _s, ...rest } = g as Record<string, unknown>;
      const next = { ...rest, ...(action.params.changes as Record<string, unknown>), supersedes_id: g.id, created_by: 'agent', user_id: userId, is_current: true };
      const { error: e1 } = await sb.from('goals').update({ is_current: false }).eq('id', g.id);
      const { error: e2 } = await sb.from('goals').insert(next);
      if (e1 || e2) throw new HttpError(400, 'Не удалось обновить цель (проверь, что калории ≥ 1500)', 'db');
      resultText = 'Цель обновлена. Старая версия сохранена в истории.';
    }
  }
  const updated = { ...meta, pending_actions: meta.pending_actions!.map((a) => (a.id === action.id ? { ...a, status: parsed.data.decision } : a)) };
  await sb.from('agent_messages').update({ meta: updated }).eq('id', msg!.id);
  await sb.from('agent_messages').insert({ user_id: userId, role: 'assistant', kind: 'event', text: resultText, parts: [{ type: 'text', text: resultText }] });
  return json({ ok: true, text: resultText });
});
