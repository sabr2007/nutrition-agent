import { z } from 'zod';
import { handler, HttpError, json, readJson, requireUser } from '@/lib/http';

const Sub = z.object({ endpoint: z.string().url().max(1000), keys: z.object({ p256dh: z.string().max(200), auth: z.string().max(100) }) });

export const POST = handler(async (req) => {
  const { userId, sb } = await requireUser(req);
  const parsed = Sub.safeParse(await readJson(req));
  if (!parsed.success) throw new HttpError(400, 'Некорректная подписка', 'validation');
  const { endpoint, keys } = parsed.data;
  await sb.from('push_subscriptions').delete().eq('endpoint', endpoint);
  const { error } = await sb.from('push_subscriptions').insert({ user_id: userId, endpoint, p256dh: keys.p256dh, auth: keys.auth, user_agent: req.headers.get('user-agent')?.slice(0, 200) ?? null });
  if (error) throw new HttpError(500, 'Не удалось сохранить подписку', 'db');
  return json({ ok: true });
});
