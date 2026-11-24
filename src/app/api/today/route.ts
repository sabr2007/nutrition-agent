import { handler, json, requireUser } from '@/lib/http';
import { getDaySummary } from '@/lib/data/day';
import { listTemplates } from '@/lib/data/meals';
import { getProfile } from '@/lib/data/profile';

export const GET = handler(async (req) => {
  const { userId, sb } = await requireUser(req);
  const day = new URL(req.url).searchParams.get('day') ?? undefined;
  if (day && !/^\d{4}-\d{2}-\d{2}$/.test(day)) return json({ error: { message: 'bad day', code: 'bad_request' } }, 400);
  const { count } = await sb.from('profiles').select('user_id', { count: 'exact', head: true }).eq('user_id', userId);
  if (!count) return json({ error: { message: 'Профиль не найден — войди заново', code: 'no_profile' } }, 401);
  const profile = await getProfile(sb, userId);
  const [summary, templates, msg, notif] = await Promise.all([
    getDaySummary(sb, userId, day, profile),
    listTemplates(sb, userId),
    sb.from('agent_messages').select('id, text, kind, created_at, meta').eq('user_id', userId).eq('role', 'assistant')
      .order('created_at', { ascending: false }).limit(1).maybeSingle(),
    sb.from('notifications').select('id, title, body, deep_link, rule_key, sent_at, status, reaction').eq('user_id', userId)
      .in('status', ['sent', 'snoozed']).is('acted_at', null).is('dismissed_at', null)
      .order('created_at', { ascending: false }).limit(1).maybeSingle(),
  ]);
  return json({
    summary,
    templates: templates.map(({ items, ...t }) => ({ ...t, items: items.map((i) => ({ food_id: i.food_id, grams: Number(i.grams), name: i.foods.name_ru, note: i.note })) })),
    coach: msg.data ?? null,
    notification: notif.data ?? null,
  });
});
