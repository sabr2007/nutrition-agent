import type { SupabaseClient } from '@supabase/supabase-js';
import { getDaySummary, type DaySummary } from '@/lib/data/day';
import { listTemplates } from '@/lib/data/meals';
import { getProfile } from '@/lib/data/profile';
import { localParts } from '@/lib/nutrition/day';
import { dueTemplates } from '@/lib/nutrition/next-template';
import type { BotApi } from './bot';
import { escapeHtml } from './format';
import { cbId, sendHtml } from './reply';
import type { Owner, TgStore } from './store';
import { HELP_HTML } from './texts';
import type { Classified } from './update';
import type { InlineButton } from './types';

export type CommandCtx = {
  bot: BotApi; store: TgStore; owner: Owner; chatId: number; appUrl: string;
  userClient: () => Promise<SupabaseClient>;
  agentTurn: (text: string, extra?: { skillKey?: string }) => Promise<{ runId?: string | null }>;
  now?: () => Date;
};

const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const MAX_MUTE_H = 72;
const DEFAULT_MUTE_H = 3;
const n0 = (v: number) => Math.round(v).toLocaleString('ru-RU');
const range = (lo: number | null | undefined, hi: number | null | undefined) => (lo != null && hi != null ? `${lo}–${hi}` : lo != null ? `${lo}+` : '—');

/** The day in a few lines: calories against the goal, macros, what is left, what was logged. */
export function todayHtml(s: DaySummary): string {
  const [, m, d] = s.day.split('-').map(Number);
  const g = s.goal;
  const lines = [`<b>${s.isToday ? 'Сегодня' : 'День'}, ${d} ${MONTHS[m - 1]}</b>${s.challengeDay ? ` · челлендж ${s.challengeDay.n}/${s.challengeDay.of}` : ''}`];
  lines.push(`${n0(s.totals.kcal)} ккал${g ? ` из ${g.kcal_min}–${g.kcal_max}` : ''}`);
  lines.push(`Б ${n0(s.totals.protein_g)} / ${range(g?.protein_min_g, g?.protein_max_g)} · Ж ${n0(s.totals.fat_g)} / ${range(g?.fat_min_g, g?.fat_max_g)} · У ${n0(s.totals.carbs_g)} / ${range(g?.carbs_min_g, g?.carbs_max_g)}`);
  if (s.totals.macros_incomplete) lines.push(`<i>БЖУ неполные: у ${s.totals.macros_incomplete} поз. известны только ккал</i>`);
  if (s.remaining) {
    const protein = s.remaining.protein_to_min > 0 ? `белка ещё ${s.remaining.protein_to_min} г` : 'белок добран ✓';
    const kcal = s.remaining.kcal_to_max >= 0 ? `до потолка ${s.remaining.kcal_to_max} ккал` : `выше потолка на ${-s.remaining.kcal_to_max} ккал`;
    lines.push(`${protein}, ${kcal}`);
  }
  if (s.meals.length) {
    lines.push('', '<b>Записано</b>');
    for (const meal of s.meals) lines.push(`${localParts(new Date(meal.eaten_at), s.profile.timezone).hhmm} ${escapeHtml(meal.title ?? 'Приём')} — ${n0(meal.kcal)} ккал`);
  } else {
    lines.push('', 'Пока ничего не записано.');
  }
  return lines.join('\n');
}

async function today(ctx: CommandCtx): Promise<{ runId?: null }> {
  const sb = await ctx.userClient();
  const profile = await getProfile(sb, ctx.owner.userId);
  const [s, templates] = await Promise.all([getDaySummary(sb, ctx.owner.userId, undefined, profile), listTemplates(sb, ctx.owner.userId)]);
  const due = dueTemplates(templates, s, ctx.now?.() ?? new Date());
  const rows: InlineButton[][] = [[{ text: '📊 Открыть «Сегодня»', web_app: { url: `${ctx.appUrl}/` } }]];
  const callbacks = due.map((t) => ({ id: cbId(), user_id: ctx.owner.userId, chat_id: ctx.chatId, message_id: null, kind: 'template', payload: { template_id: t.id, name: t.name } }));
  callbacks.forEach((cb, i) => rows.push([{ text: `＋ ${due[i].name} · ${due[i].kcal} ккал`, callback_data: `c:${cb.id}` }]));
  await ctx.store.saveCallbacks(callbacks);
  await sendHtml(ctx.bot, ctx.chatId, todayHtml(s), { inline_keyboard: rows });
  return {};
}

export async function handleCommand(c: Classified, ctx: CommandCtx): Promise<{ runId?: string | null }> {
  const name = c.command?.name ?? '';
  const now = ctx.now?.() ?? new Date();
  switch (name) {
    case 'today':
      return today(ctx);
    case 'week':
      return ctx.agentTurn('Сделай разбор недели: вес в среднем, дни в плане, белок, срывы и одна цель на неделю.', { skillKey: 'weekly_review' });
    case 'deep':
      await ctx.store.setChatState(ctx.chatId, { deepNext: true });
      await ctx.bot.sendMessage(ctx.chatId, 'Следующий ответ подумаю дольше — модель посильнее, может занять пару минут. Пиши вопрос.');
      return {};
    case 'mute': {
      const hours = Math.min(MAX_MUTE_H, Math.max(1, Number.parseFloat(c.command?.arg.replace(',', '.') ?? '') || DEFAULT_MUTE_H));
      const until = new Date(now.getTime() + hours * 3600_000);
      await ctx.store.setChatState(ctx.chatId, { mutedUntil: until.toISOString() });
      await ctx.bot.sendMessage(ctx.chatId, `Тишина до ${localParts(until).hhmm}${hours >= 24 ? ` (${localParts(until).date})` : ''}: сам писать не буду, напоминания подождут. Ответы на твои сообщения — как обычно.`);
      return {};
    }
    default:
      await ctx.bot.sendMessage(ctx.chatId, HELP_HTML, { parse_mode: 'HTML' });
      return {};
  }
}
