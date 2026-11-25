import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { BotApi } from './bot';

// Short status reports of the v2 rollout, versioned with the code. Each is delivered once to the
// linked owner (right after pairing, then by the cron tick after each deploy) and marked [v2-test]:
// it doubles as the production check that the bot can reach the owner.

export const PHASE_REPORTS: { id: string; html: string }[] = [
  {
    id: 'v2-phase-0-2',
    html: [
      '<b>v2 · фазы 0–2 готовы</b>',
      '',
      '<b>Сделано</b>',
      '• Баг «Fuse Tea → батат» исправлен: продукт без точного совпадения больше не подставляется — спрошу кнопками или запишу твои цифры (save_user_food); «исправь, там 250» правит ту же запись.',
      '• Бот: текст, фото, альбомы до 4 фото, голосовые (расшифровка первой строкой), кнопки-варианты, подтверждения, карточки записанного, /today, /week, /deep, /mute.',
      '• Ответ печатается вживую (черновик Telegram), длинные — по частям.',
      '',
      '<b>Проверено</b>: 153 теста, eval агента в проде, вебхук в проде (секрет, дубликаты, чужие — отказ без модели).',
      '',
      '<b>От тебя</b>: напиши мне что-нибудь из еды — это и есть проверка. Google Health — шаги в docs/BLOCKERS.md.',
    ].join('\n'),
  },
];

/** Sends the reports the linked owner has not seen yet; returns how many were sent. */
export async function deliverPhaseReports(admin: SupabaseClient, bot: BotApi): Promise<number> {
  const { data: owner } = await admin.from('profiles').select('user_id, telegram_chat_id').not('telegram_chat_id', 'is', null).limit(1).maybeSingle();
  if (!owner?.telegram_chat_id) return 0;
  const chatId = Number(owner.telegram_chat_id);
  const { data: chat } = await admin.from('tg_chats').select('reports_sent').eq('chat_id', chatId).maybeSingle();
  const sent = new Set<string>((chat?.reports_sent as string[]) ?? []);
  let count = 0;
  for (const r of PHASE_REPORTS) {
    if (sent.has(r.id)) continue;
    await bot.sendMessage(chatId, `[v2-test] ${r.html}`, { parse_mode: 'HTML' });
    sent.add(r.id);
    count++;
    await admin.from('tg_chats').upsert({ chat_id: chatId, user_id: owner.user_id, reports_sent: [...sent], updated_at: new Date().toISOString() }, { onConflict: 'chat_id' });
  }
  return count;
}
