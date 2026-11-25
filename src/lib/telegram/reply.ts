import { randomBytes } from 'node:crypto';
import type { AgentResult } from '@/lib/agent/run';
import type { BotApi } from './bot';
import { TelegramError } from './bot';
import { escapeHtml, stripHtml, toTelegramMessages } from './format';
import type { CallbackRow, TgStore } from './store';
import type { InlineButton, InlineKeyboard } from './types';

// The agent's reply in Telegram: formatted text, a compact block of what was written, and
// inline buttons — choices (ask_user), confirmations, memory proposals, meal edit/delete.
// callback_data carries only a short id; the payload lives in tg_callbacks (≤ 64 bytes rule).

/** Choice buttons start with «q:» so a press can drop exactly them; others «c:»; «n» does nothing. */
export const NOOP = 'n';
export const cbId = () => randomBytes(9).toString('base64url');

export type ReplyCtx = { bot: BotApi; store: TgStore; userId: string; chatId: number; appUrl: string };

export type BuiltReply = { messages: string[]; keyboard: InlineKeyboard | null; callbacks: CallbackRow[] };

const fmt = (n: number | undefined) => (n == null ? '—' : String(Math.round(n)));

/** «🍽 Обед — 640 ккал · Б 52 · Ж 18 · У 61» lines and the other writes as «✓ …». */
export function writtenBlock(r: Pick<AgentResult, 'ui'>): string {
  const lines = [
    ...r.ui.loggedMeals.filter((m) => m.id !== 'dry-run').map((m) => `🍽 ${escapeHtml(m.title)} — ${fmt(m.kcal)} ккал · Б ${fmt(m.protein_g)} · Ж ${fmt(m.fat_g)} · У ${fmt(m.carbs_g)}`),
    ...r.ui.actions.map((a) => `✓ ${escapeHtml(a.text)}`),
  ];
  return lines.join('\n');
}

export function buildReply(r: AgentResult, ctx: Pick<ReplyCtx, 'userId' | 'chatId' | 'appUrl'>, opts: { prefix?: string; newId?: () => string } = {}): BuiltReply {
  const newId = opts.newId ?? cbId;
  const callbacks: CallbackRow[] = [];
  const rows: InlineButton[][] = [];
  const button = (text: string, kind: string, payload: Record<string, unknown>, prefix = 'c'): InlineButton => {
    const id = newId();
    callbacks.push({ id, user_id: ctx.userId, chat_id: ctx.chatId, message_id: null, kind, payload });
    return { text, callback_data: `${prefix}:${id}` };
  };
  const choices = r.ui.choices;
  if (choices) {
    const short = choices.options.every((o) => o.length <= 14);
    const btns = choices.options.map((o) => button(o, 'choice', { option: o, question: choices.question }, 'q'));
    for (let i = 0; i < btns.length; i += short ? 2 : 1) rows.push(btns.slice(i, i + (short ? 2 : 1)));
  }
  for (const a of r.ui.pendingActions) {
    const base = { agent_message_id: r.messageId, action_id: a.id, summary: a.summary };
    rows.push([button(a.kind === 'delete_meal' ? '🗑 Да, удалить' : '✓ Да, изменить', 'confirm', { ...base, decision: 'confirm' }), button('Отмена', 'confirm', { ...base, decision: 'cancel' })]);
  }
  for (const m of r.ui.proposedMemories) {
    rows.push([button('Запомнить', 'memory', { memory_id: m.id, accept: true, agent_message_id: r.messageId }), button('Не надо', 'memory', { memory_id: m.id, accept: false, agent_message_id: r.messageId })]);
  }
  for (const o of r.ui.suggestions ?? []) {
    const label = `Записать: ${o.title.length > 28 ? `${o.title.slice(0, 27)}…` : o.title} · ${o.kcal} ккал`;
    rows.push([button(label, 'log_option', { title: o.title, items: o.items })]);
  }
  for (const m of r.ui.loggedMeals.filter((x) => x.id !== 'dry-run')) {
    rows.push([
      { text: '✏️ Исправить', web_app: { url: `${ctx.appUrl}/?meal=${encodeURIComponent(m.id)}` } },
      button('🗑 Удалить', 'meal_delete', { meal_id: m.id, title: m.title, kcal: m.kcal }),
    ]);
  }
  const written = writtenBlock(r);
  const head = [opts.prefix, r.text].filter(Boolean).join('\n\n');
  const messages = toTelegramMessages(head);
  if (written) {
    const last = messages.pop() ?? '';
    const joined = last ? `${last}\n\n${written}` : written;
    if (joined.length <= 4096) messages.push(joined);
    else messages.push(last, written);
  }
  return { messages: messages.filter(Boolean), keyboard: rows.length ? { inline_keyboard: rows } : null, callbacks };
}

/** Sends HTML; if Telegram cannot parse it, sends the same text plain. */
export async function sendHtml(bot: BotApi, chatId: number, html: string, keyboard?: InlineKeyboard | null): Promise<number> {
  const extra = { link_preview_options: { is_disabled: true }, ...(keyboard ? { reply_markup: keyboard } : {}) };
  try {
    return (await bot.sendMessage(chatId, html, { parse_mode: 'HTML', ...extra })).message_id;
  } catch (e) {
    if (!(e instanceof TelegramError && e.code === 400 && /parse|entit|tag/i.test(e.description))) throw e;
    return (await bot.sendMessage(chatId, stripHtml(html), extra)).message_id;
  }
}

/** Sends the agent's reply; buttons go on the last message. Returns the sent message ids. */
export async function sendAgentReply(ctx: ReplyCtx, r: AgentResult, opts: { prefix?: string } = {}): Promise<number[]> {
  return sendBuilt(ctx, buildReply(r, ctx, opts));
}

/** Saves the buttons' payloads, then sends the messages with the keyboard under the last one. */
export async function sendBuilt(ctx: Pick<ReplyCtx, 'bot' | 'store' | 'chatId'>, built: BuiltReply): Promise<number[]> {
  await ctx.store.saveCallbacks(built.callbacks);
  const ids: number[] = [];
  for (let i = 0; i < built.messages.length; i++) {
    const last = i === built.messages.length - 1;
    ids.push(await sendHtml(ctx.bot, ctx.chatId, built.messages[i], last ? built.keyboard : null));
  }
  return ids;
}
