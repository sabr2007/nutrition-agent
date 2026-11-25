import type { BotApi } from './bot';
import { toTelegramMessages } from './format';
import { cbId, sendBuilt, type BuiltReply } from './reply';
import type { TgStore } from './store';
import type { InlineButton } from './types';

// Proactive messages in Telegram (D29): the reminder's text and the buttons to react —
//  * reminders the owner set up: ✓ Сделал · ⏰ 15 мин · 🔕 Не сегодня;
//  * the agent's own messages: its «Записать» options (if any) and 🔕 Не сегодня;
//  * «долго без еды»: Ел, сейчас запишу · Не ел · Позже.
// A press is a reaction: it lands in notifications and lifts the «3 without a reaction» silence.

export type ButtonSet = 'reminder' | 'agent' | 'food_check';
export type NotifyAction = 'done' | 'snooze' | 'not_today' | 'will_log' | 'not_eaten';
export type NoteSuggestion = { title: string; kcal: number; items: { food_id: string; name: string; grams: number }[] };
export type OutgoingNote = { id: string; body: string; buttons: ButtonSet; suggestions?: NoteSuggestion[] };

export const SNOOZE_MIN = 15;
export const LATER_MIN = 60;

export function buildNotification(n: OutgoingNote, ctx: { userId: string; chatId: number }, newId: () => string = cbId): BuiltReply {
  const callbacks: BuiltReply['callbacks'] = [];
  const button = (text: string, kind: string, payload: Record<string, unknown>): InlineButton => {
    const id = newId();
    callbacks.push({ id, user_id: ctx.userId, chat_id: ctx.chatId, message_id: null, kind, payload });
    return { text, callback_data: `c:${id}` };
  };
  const react = (text: string, action: NotifyAction, minutes?: number) => button(text, 'notify', { notification_id: n.id, action, ...(minutes ? { minutes } : {}) });
  const rows: InlineButton[][] = [];
  if (n.buttons === 'food_check') {
    rows.push([react('Ел, сейчас запишу', 'will_log')], [react('Не ел', 'not_eaten'), react('Позже', 'snooze', LATER_MIN)]);
  } else if (n.buttons === 'agent') {
    for (const o of n.suggestions ?? []) {
      const label = `Записать: ${o.title.length > 28 ? `${o.title.slice(0, 27)}…` : o.title} · ${o.kcal} ккал`;
      rows.push([button(label, 'log_option', { title: o.title, items: o.items })]);
    }
    rows.push([react('🔕 Не сегодня', 'not_today')]);
  } else {
    rows.push([react('✓ Сделал', 'done'), react(`⏰ ${SNOOZE_MIN} мин`, 'snooze', SNOOZE_MIN), react('🔕 Не сегодня', 'not_today')]);
  }
  return { messages: toTelegramMessages(n.body), keyboard: { inline_keyboard: rows }, callbacks };
}

/** Sends the reminder; returns the id of the message that carries the buttons. */
export async function sendNotification(deps: { bot: BotApi; store: TgStore }, chatId: number, userId: string, n: OutgoingNote): Promise<number> {
  const ids = await sendBuilt({ bot: deps.bot, store: deps.store, chatId }, buildNotification(n, { userId, chatId }));
  return ids[ids.length - 1];
}

/** The mark that replaces the pressed buttons. */
export function reactionLabel(action: NotifyAction, at?: string, tz?: string): string {
  switch (action) {
    case 'done': return '✓ Сделал';
    case 'snooze': return at ? `⏰ Напомню в ${new Date(at).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', timeZone: tz })}` : '⏰ Напомню позже';
    case 'not_today': return '🔕 Сегодня больше не напомню';
    case 'will_log': return 'Жду: напиши или пришли фото';
    case 'not_eaten': return 'Ок, не ел';
  }
}
