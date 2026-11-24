import { z } from 'zod';
import { handler, HttpError, json, readJson, requireUser } from '@/lib/http';

const Body = z.object({ action: z.enum(['opened', 'snoozed', 'done', 'dismissed']) });
const SNOOZE_MIN = 15;

export const POST = handler(async (req, ctx: { params: Promise<{ id: string }> }) => {
  const { userId, sb } = await requireUser(req);
  const { id } = await ctx.params;
  const parsed = Body.safeParse(await readJson(req));
  if (!parsed.success) throw new HttpError(400, 'Некорректное действие', 'validation');
  const { data: n } = await sb.from('notifications').select('*').eq('id', id).eq('user_id', userId).single();
  if (!n) throw new HttpError(404, 'Не найдено', 'not_found');
  const now = new Date().toISOString();
  const a = parsed.data.action;
  const patch: Record<string, unknown> = { reaction: a };
  if (a === 'opened') patch.opened_at = n.opened_at ?? now;
  if (a === 'done') patch.acted_at = now;
  if (a === 'dismissed') patch.dismissed_at = now;
  if (a === 'snoozed') {
    const until = new Date(Date.now() + SNOOZE_MIN * 60_000).toISOString();
    patch.snoozed_until = until;
    patch.status = 'snoozed';
    // The snoozed reminder comes back as a fresh pending notification.
    await sb.from('notifications').insert({ user_id: userId, rule_key: n.rule_key, local_day: n.local_day, title: n.title, body: n.body, deep_link: n.deep_link, status: 'pending', scheduled_for: until, payload: { snoozed_from: n.id } });
  }
  await sb.from('notifications').update(patch).eq('id', id);
  return json({ ok: true });
});
