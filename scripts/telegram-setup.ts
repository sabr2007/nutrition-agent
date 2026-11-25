/**
 * Registers the bot with Telegram (idempotent): webhook with the secret header, commands and
 * the menu button that opens the Mini App. Reads TELEGRAM_BOT_TOKEN and TELEGRAM_WEBHOOK_SECRET
 * from the environment; never prints them.
 *
 *   node --env-file=.env.local --import tsx scripts/telegram-setup.ts [--app-url https://…] [--keep-pending] [--info]
 */
import { argValue, envValue, resolveAppUrl } from './lib/login-config';
import { BOT_COMMANDS } from '../src/lib/telegram/texts';

type Envelope<T> = { ok: boolean; result?: T; description?: string };

async function call<T>(token: string, method: string, params: Record<string, unknown> = {}): Promise<T> {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(params),
  });
  const body = (await res.json()) as Envelope<T>;
  if (!body.ok) throw new Error(`${method}: ${body.description ?? res.status}`);
  return body.result as T;
}

async function main() {
  const argv = process.argv.slice(2);
  const token = envValue(process.env.TELEGRAM_BOT_TOKEN);
  const secret = envValue(process.env.TELEGRAM_WEBHOOK_SECRET);
  if (!token || !secret) throw new Error('Нужны TELEGRAM_BOT_TOKEN и TELEGRAM_WEBHOOK_SECRET (например, из .env.local)');
  if (!/^[A-Za-z0-9_-]{1,256}$/.test(secret)) throw new Error('TELEGRAM_WEBHOOK_SECRET: только A-Z, a-z, 0-9, _ и -, до 256 символов');
  // The webhook must be public https: APP_URL from a local env file would point at localhost.
  const appUrl = resolveAppUrl(argValue(argv, '--app-url'), undefined);
  const me = await call<{ username: string }>(token, 'getMe');
  console.log(`Бот: @${me.username}; приложение: ${appUrl}`);

  if (!argv.includes('--info')) {
    await call(token, 'setWebhook', {
      url: `${appUrl}/api/telegram/webhook`,
      secret_token: secret,
      allowed_updates: ['message', 'callback_query'],
      drop_pending_updates: !argv.includes('--keep-pending'),
      max_connections: 10,
    });
    await call(token, 'setMyCommands', { commands: BOT_COMMANDS });
    await call(token, 'setChatMenuButton', { menu_button: { type: 'web_app', text: 'Рядом', web_app: { url: `${appUrl}/` } } });
    console.log('Вебхук, команды и кнопка меню обновлены.');
  }
  const info = await call<{ url: string; pending_update_count: number; last_error_date?: number; last_error_message?: string; allowed_updates?: string[]; max_connections?: number }>(token, 'getWebhookInfo');
  console.log(JSON.stringify({
    url: info.url, pending: info.pending_update_count, allowed_updates: info.allowed_updates, max_connections: info.max_connections,
    last_error: info.last_error_message ? `${new Date((info.last_error_date ?? 0) * 1000).toISOString()} ${info.last_error_message}` : null,
  }, null, 2));
}

main().catch((e) => { console.error((e as Error).message); process.exit(1); });
