import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { sendPush } from '@/lib/push/send';
import { telegramConfigured, telegramRuntime } from '@/lib/telegram/deps';
import { sendNotification, type ButtonSet, type NoteSuggestion } from '@/lib/telegram/notify';

// Where a proactive message goes (D29): the owner's Telegram chat once it is linked; until then
// (and if Telegram fails) the v1 Web Push, so nothing is lost while the bot is being paired.

export type Outgoing = {
  id: string; title: string; body: string; deep_link: string | null; rule_key: string | null;
  payload?: { buttons?: ButtonSet; suggestions?: NoteSuggestion[] } | null;
};

export type Deliver = (admin: SupabaseClient, userId: string, n: Outgoing) => Promise<number>;

const PUSH_BODY_MAX = 300;

async function linkedChat(admin: SupabaseClient, userId: string): Promise<number | null> {
  const { data } = await admin.from('profiles').select('telegram_chat_id').eq('user_id', userId).maybeSingle();
  return data?.telegram_chat_id != null ? Number(data.telegram_chat_id) : null;
}

async function viaPush(admin: SupabaseClient, userId: string, n: Outgoing): Promise<number> {
  const r = await sendPush(admin, userId, { title: n.title, body: n.body.slice(0, PUSH_BODY_MAX), url: n.deep_link ?? '/', notificationId: n.id, tag: n.rule_key ?? undefined });
  await admin.from('notifications').update({
    // No subscription (or push not configured) → still "sent": it shows in the app.
    status: r.delivered > 0 || !r.configured || r.subscriptions === 0 ? 'sent' : 'failed', channel: 'push', sent_at: new Date().toISOString(), delivered_count: r.delivered,
  }).eq('id', n.id);
  return r.delivered;
}

export const deliver: Deliver = async (admin, userId, n) => {
  const chatId = telegramConfigured() ? await linkedChat(admin, userId) : null;
  if (chatId == null) return viaPush(admin, userId, n);
  try {
    const rt = telegramRuntime();
    const messageId = await sendNotification({ bot: rt.bot, store: rt.store }, chatId, userId, {
      id: n.id, body: n.body, buttons: n.payload?.buttons ?? 'reminder', suggestions: n.payload?.suggestions,
    });
    await admin.from('notifications').update({ status: 'sent', channel: 'telegram', tg_message_id: messageId, sent_at: new Date().toISOString(), delivered_count: 1 }).eq('id', n.id);
    return 1;
  } catch (e) {
    console.error('[reminders] telegram delivery failed, falling back to push', (e as Error).message?.slice(0, 160));
    return viaPush(admin, userId, n);
  }
};
