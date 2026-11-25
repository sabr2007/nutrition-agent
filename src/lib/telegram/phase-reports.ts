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
  {
    id: 'v2-phase-3-6',
    html: [
      '<b>v2 · фазы 3–6 готовы</b>',
      '',
      '<b>Сделано</b>',
      '• Модель агента — gpt-6.1-sol: eval в проде 21/21 до переключения (luna было 18/21). Продукты ищу сам: твоя база → Open Food Facts → интернет (страница производителя), найденное сохраняю с ссылкой.',
      '• Фото на кухонных весах: вес с дисплея, продукт по упаковке, одна строка расчёта «46 г × 419 ккал/100 г = 193 ккал».',
      '• Жиры: после записи код проверяет приём и день; одно предупреждение с заменой в граммах. «Что съесть» — варианты по белку на 100 ккал с кнопками «Записать».',
      '• Напоминания — сюда, с кнопками ✓ Сделал · ⏰ 15 мин · 🔕 Не сегодня. Сам пишу до 6 раз в день, с паузой ≥ 90 мин, после трёх без ответа молчу. Новые: утро, белок к 15:00, шаги к 18:00, после тренировки, 5 часов без еды.',
      '• Браслет: Google Health (шаги, сон, тренировки) — подключение в Mini App.',
      '• Mini App: Сегодня · Тело · Ещё; приём правится прямо в журнале; чек-листа больше нет — «сделано» считаю по записям и кнопкам.',
      '• Кончился лимит ChatGPT — простое («грудка 250») и шаблоны записываю без модели.',
      '',
      '<b>Проверено</b>: 202 теста, eval в проде, миграции в проде, e2e Mini App против прода.',
      '',
      '<b>От тебя</b>: открой Mini App кнопкой меню; Google Health — шаги в docs/BLOCKERS.md; скажи «бот работает» — уберу запасной вход (старый чат).',
    ].join('\n'),
  },
  {
    id: 'v2-phase-7-8',
    html: [
      '<b>v2 · фазы 7–8 готовы — v2 завершена</b>',
      '',
      '<b>Скорость</b>',
      '• «Сегодня» грузит 146 KB JS вместо 215; знакомый день — на экране за ~0,25 с, «вчера» — мгновенно.',
      '• Сводка дня с сервера: 181 мс медиана, 280 мс p95 (было 1 028 / 1 992): функции переехали во Франкфурт к базе.',
      '',
      '<b>Финал</b>: проверка секретов — чисто; документация обновлена (README, ARCHITECTURE, SETUP, SUMMARY v2, решения D24–D31).',
      '',
      '<b>От тебя</b>: Google Health — 5 шагов в docs/BLOCKERS.md; напиши «бот работает» — удалю старый чат, ручную запись и пуши.',
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
