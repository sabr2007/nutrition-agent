// Fixed bot texts (Telegram HTML).

export const HELP_HTML = [
  'Пиши, что съел, — я запишу и посчитаю КБЖУ по базе продуктов. Можно фото тарелки или этикетки, голосовое, «завтрак как обычно».',
  '',
  '<b>Команды</b>',
  '/today — итог дня',
  '/week — разбор недели',
  '/deep — следующий ответ подумаю дольше',
  '/mute 3 — тишина на 3 часа',
  '/help — эта справка',
  '',
  'Остальное — обычным текстом: «что съесть на ужин?», «исправь, там 250 ккал», «вес 97,4».',
].join('\n');

export const BOT_COMMANDS = [
  { command: 'today', description: 'Итог дня' },
  { command: 'week', description: 'Разбор недели' },
  { command: 'deep', description: 'Следующий ответ — подумать дольше' },
  { command: 'mute', description: 'Тишина на N часов: /mute 3' },
  { command: 'help', description: 'Справка' },
];

export const RETRY_NOTICE = 'Не смог обработать сообщение — повторю через пару минут.';
export const GAVE_UP_NOTICE = 'Так и не смог обработать это сообщение. Напиши его ещё раз, пожалуйста.';
