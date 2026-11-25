import type { SupabaseClient } from '@supabase/supabase-js';

// Dangerous actions the agent proposed (delete a meal, change the goal) run only after the
// person presses the button — in the app or in Telegram. One implementation for both.

export type ConfirmResult = { ok: true; text: string } | { ok: false; status: number; code: string; message: string };

type Pending = { id: string; kind: string; params: Record<string, unknown>; status?: string; summary: string };

export async function confirmAction(sb: SupabaseClient, userId: string, messageId: string, actionId: string, decision: 'confirm' | 'cancel'): Promise<ConfirmResult> {
  const { data: msg } = await sb.from('agent_messages').select('id, meta').eq('id', messageId).eq('user_id', userId).maybeSingle();
  const meta = (msg?.meta ?? {}) as { pending_actions?: Pending[] };
  const action = meta.pending_actions?.find((a) => a.id === actionId);
  if (!msg || !action) return { ok: false, status: 404, code: 'not_found', message: 'Действие не найдено' };
  if (action.status) return { ok: false, status: 409, code: 'done', message: 'Уже обработано' };
  let text = 'Отменено.';
  if (decision === 'confirm') {
    if (action.kind === 'delete_meal') {
      const { error } = await sb.rpc('delete_meal', { p_id: action.params.meal_id as string });
      if (error) return { ok: false, status: 400, code: 'db', message: 'Не удалось удалить' };
      text = 'Удалил. История сохранена.';
    } else if (action.kind === 'update_goal') {
      const { data: g } = await sb.from('goals').select('*').eq('id', action.params.goal_id as string).eq('user_id', userId).eq('is_current', true).maybeSingle();
      if (!g) return { ok: false, status: 404, code: 'not_found', message: 'Цель не найдена' };
      const { id: _id, created_at: _c, supersedes_id: _s, ...rest } = g as Record<string, unknown>;
      const next = { ...rest, ...(action.params.changes as Record<string, unknown>), supersedes_id: g.id, created_by: 'agent', user_id: userId, is_current: true };
      const { error: e1 } = await sb.from('goals').update({ is_current: false }).eq('id', g.id);
      const { error: e2 } = await sb.from('goals').insert(next);
      if (e1 || e2) return { ok: false, status: 400, code: 'db', message: 'Не удалось обновить цель (проверь, что калории ≥ 1500)' };
      text = 'Цель обновлена. Старая версия сохранена в истории.';
    }
  }
  const updated = { ...meta, pending_actions: meta.pending_actions!.map((a) => (a.id === action.id ? { ...a, status: decision } : a)) };
  await sb.from('agent_messages').update({ meta: updated }).eq('id', msg.id);
  await sb.from('agent_messages').insert({ user_id: userId, role: 'assistant', kind: 'event', text, parts: [{ type: 'text', text }] });
  return { ok: true, text };
}
