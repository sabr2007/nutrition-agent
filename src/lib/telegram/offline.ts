import type { ErrorClass } from '@/lib/llm/router';
import { escapeHtml } from './format';
import { cbId, type BuiltReply } from './reply';

// When the agent is out (the ChatGPT plan's limit is spent, or the plan is disconnected), the bot
// keeps the free paths: the quick parser for simple text («грудка 250, рис 150») and one-tap
// templates. Both write through the base, no model involved.

/** Errors that will not pass by retrying in a minute. */
export const AGENT_DOWN: ReadonlySet<ErrorClass> = new Set(['quota', 'auth', 'not_connected']);

export type OfflineOffer = {
  /** The whole text understood by the quick parser, or null. */
  quick: { title: string; kcal: number; items: { food_id: string; name: string; grams: number }[] } | null;
  templates: { id: string; name: string; kcal: number }[];
};

export const MAX_OFFLINE_TEMPLATES = 4;

const HEAD: Partial<Record<ErrorClass, string>> = {
  quota: 'Лимит подписки ChatGPT сейчас исчерпан — агент вернётся, когда лимит обновится.',
  auth: 'ChatGPT отключился — переподключи его в приложении: «Ещё» → «Настройки».',
  not_connected: 'ChatGPT не подключён — подключи его в приложении: «Ещё» → «Настройки».',
};

export function buildOfflineReply(cls: ErrorClass, offer: OfflineOffer, ctx: { userId: string; chatId: number }, newId: () => string = cbId): BuiltReply {
  const callbacks: BuiltReply['callbacks'] = [];
  const button = (text: string, kind: string, payload: Record<string, unknown>) => {
    const id = newId();
    callbacks.push({ id, user_id: ctx.userId, chat_id: ctx.chatId, message_id: null, kind, payload });
    return { text, callback_data: `c:${id}` };
  };
  const lines = [escapeHtml(HEAD[cls] ?? HEAD.quota!)];
  const rows = [];
  if (offer.quick) {
    lines.push(`Без агента понял так: ${escapeHtml(offer.quick.title)} — ${offer.quick.kcal} ккал.`);
    rows.push([button(`Записать · ${offer.quick.kcal} ккал`, 'log_option', { title: offer.quick.title, items: offer.quick.items })]);
  } else {
    lines.push('Без агента записываю простое: «грудка 250, рис 150», «3 яйца».');
  }
  const templates = offer.templates.slice(0, MAX_OFFLINE_TEMPLATES);
  if (templates.length) {
    lines.push('Или шаблон одной кнопкой:');
    for (const t of templates) rows.push([button(`${t.name} · ${t.kcal} ккал`, 'template', { template_id: t.id })]);
  }
  return { messages: [lines.join('\n')], keyboard: rows.length ? { inline_keyboard: rows } : null, callbacks };
}
