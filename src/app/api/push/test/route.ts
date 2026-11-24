import { handler, json, requireUser } from '@/lib/http';
import { supabaseAdmin } from '@/lib/supabase/server';
import { sendPush } from '@/lib/push/send';

export const POST = handler(async (req) => {
  const { userId, sb } = await requireUser(req);
  const { data: n } = await sb.from('notifications').insert({ user_id: userId, rule_key: 'test', title: 'Рядом', body: 'Проверка связи: напоминания работают.', status: 'sent', sent_at: new Date().toISOString(), deep_link: '/' }).select('id').single();
  const r = await sendPush(supabaseAdmin(), userId, { title: 'Рядом', body: 'Проверка связи: напоминания работают.', url: '/', notificationId: n?.id as string });
  return json(r);
});
