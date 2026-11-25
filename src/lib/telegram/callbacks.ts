import type { SupabaseClient } from '@supabase/supabase-js';
import { confirmAction } from '@/lib/agent/confirm';
import { logTemplate, saveMeal } from '@/lib/data/meals';
import type { BotApi } from './bot';
import { escapeHtml } from './format';
import { reactionLabel, type NotifyAction } from './notify';
import { NOOP, sendHtml } from './reply';
import type { Owner, StoredUpdate, TgStore } from './store';
import type { InlineButton, InlineKeyboard } from './types';
import type { Classified } from './update';

// A button press. The spinner was already stopped by the webhook (answerCallbackQuery); here the
// action runs once — a used or expired id does nothing — and the pressed message is edited:
// its buttons go away and the choice is marked.

export type CallbackCtx = {
  bot: BotApi; store: TgStore; owner: Owner; chatId: number;
  userClient: () => Promise<SupabaseClient>;
  agentTurn: (text: string) => Promise<{ runId?: string | null }>;
};

type MarkupHolder = { callback_query?: { message?: { reply_markup?: InlineKeyboard } } };

/** The pressed message's keyboard with the given row(s) replaced by a non-clickable mark. */
export function markKeyboard(markup: InlineKeyboard | undefined, match: (b: InlineButton) => boolean, label: string): InlineKeyboard {
  const rows = markup?.inline_keyboard ?? [];
  const at = rows.findIndex((r) => r.some(match));
  const kept = rows.filter((r) => !r.some(match));
  const mark = [{ text: label, callback_data: NOOP }];
  if (at < 0) return { inline_keyboard: [mark, ...kept] };
  kept.splice(Math.min(at, kept.length), 0, mark);
  return { inline_keyboard: kept };
}

async function edit(ctx: CallbackCtx, messageId: number | undefined, markup: InlineKeyboard): Promise<void> {
  if (messageId) await ctx.bot.editMessageReplyMarkup(ctx.chatId, messageId, markup).catch(() => undefined);
}

export async function handleCallback(u: StoredUpdate, c: Classified, ctx: CallbackCtx): Promise<{ runId?: string | null }> {
  const data = c.callback?.data ?? '';
  if (!data || data === NOOP) return {};
  const [prefix, id] = data.split(':');
  if (!id) return {};
  const row = await ctx.store.takeCallback(id, ctx.owner.userId);
  if (!row) return {};
  const markup = (u.payload as MarkupHolder).callback_query?.message?.reply_markup;
  const messageId = c.callback?.messageId;
  const p = row.payload as Record<string, string | number | boolean | null>;
  const pressed = (b: InlineButton) => b.callback_data === data;
  const pressedRow = markup?.inline_keyboard.find((r) => r.some(pressed)) ?? [];
  const inPressedRow = (b: InlineButton) => pressedRow.some((x) => (x.callback_data != null && x.callback_data === b.callback_data) || (x.web_app != null && x.web_app.url === b.web_app?.url));

  switch (row.kind) {
    case 'choice': {
      // All choice buttons of the question go; the picked one stays as a mark.
      await edit(ctx, messageId, markKeyboard(markup, (b) => Boolean(b.callback_data?.startsWith(`${prefix}:`)), `✓ ${p.option}`));
      return ctx.agentTurn(String(p.option));
    }
    case 'confirm': {
      const sb = await ctx.userClient();
      const r = await confirmAction(sb, ctx.owner.userId, String(p.agent_message_id), String(p.action_id), p.decision === 'confirm' ? 'confirm' : 'cancel');
      const label = !r.ok ? r.message : p.decision === 'confirm' ? '✓ Готово' : 'Отменено';
      await edit(ctx, messageId, markKeyboard(markup, inPressedRow, label));
      if (r.ok) await ctx.bot.sendMessage(ctx.chatId, r.text);
      return {};
    }
    case 'memory': {
      const sb = await ctx.userClient();
      const accept = Boolean(p.accept);
      await sb.from('memories').update({ status: accept ? 'active' : 'rejected' }).eq('id', String(p.memory_id)).eq('user_id', ctx.owner.userId);
      await edit(ctx, messageId, markKeyboard(markup, inPressedRow, accept ? '✓ Запомнил' : 'Не запоминаю'));
      return {};
    }
    case 'meal_delete': {
      const sb = await ctx.userClient();
      const { error } = await sb.rpc('delete_meal', { p_id: String(p.meal_id) });
      await edit(ctx, messageId, markKeyboard(markup, inPressedRow, error ? 'Не удалось удалить' : '🗑 Удалено'));
      if (!error) await sendHtml(ctx.bot, ctx.chatId, `Удалил «${escapeHtml(String(p.title ?? 'приём'))}» (${p.kcal} ккал). История сохранена.`);
      return {};
    }
    case 'log_option': {
      // A «что съесть» option logged as offered: grams from the suggestion, macros from the base.
      const sb = await ctx.userClient();
      const items = (row.payload.items as { food_id: string; name: string; grams: number }[]) ?? [];
      const saved = await saveMeal(sb, ctx.owner.userId, {
        eaten_at: new Date().toISOString(), title: String(p.title), input_method: 'agent', client_id: `tg:${id}`,
        items: items.map((i) => ({ food_id: i.food_id, name: i.name, grams: i.grams, source: 'agent' as const })),
      });
      await edit(ctx, messageId, markKeyboard(markup, pressed, `✓ Записано: ${String(p.title).slice(0, 30)}`));
      await sendHtml(ctx.bot, ctx.chatId, `🍽 ${escapeHtml(String(p.title))} — ${Math.round(saved.kcal)} ккал · Б ${Math.round(saved.protein_g)} · Ж ${Math.round(saved.fat_g)} · У ${Math.round(saved.carbs_g)}`);
      return {};
    }
    case 'template': {
      const sb = await ctx.userClient();
      const saved = await logTemplate(sb, ctx.owner.userId, { templateId: String(p.template_id), clientId: `tg:${id}` });
      await edit(ctx, messageId, markKeyboard(markup, pressed, `✓ ${saved.name} записан`));
      await sendHtml(ctx.bot, ctx.chatId, `🍽 ${escapeHtml(saved.name)} — ${Math.round(saved.kcal)} ккал · Б ${Math.round(saved.protein_g)} · Ж ${Math.round(saved.fat_g)} · У ${Math.round(saved.carbs_g)}`);
      return {};
    }
    case 'notify': {
      // A reaction to a reminder: ✓ / ⏰ / 🔕, or the «долго без еды» answers.
      const action = String(p.action) as NotifyAction;
      const reaction = action === 'snooze' ? 'snoozed' : action;
      const r = await ctx.store.reactToNotification(ctx.owner.userId, String(p.notification_id), reaction, { snoozeMinutes: Number(p.minutes) || undefined });
      if (!r.ok) return {};
      // «Записать» options under an agent message stay; the reaction buttons become the mark.
      await edit(ctx, messageId, markKeyboard(markup, (b) => !b.text.startsWith('Записать:'), reactionLabel(action, r.at)));
      if (action === 'will_log') await ctx.bot.sendMessage(ctx.chatId, 'Пиши, что ел, или пришли фото — запишу.');
      return {};
    }
    default:
      return {};
  }
}
