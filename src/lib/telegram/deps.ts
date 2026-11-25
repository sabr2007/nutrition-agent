import 'server-only';
import { after } from 'next/server';
import { runAgent } from '@/lib/agent/run';
import { ownerAccessToken } from '@/lib/auth/owner-session';
import { serverEnv } from '@/lib/env';
import { supabaseAdmin, supabaseAsUser } from '@/lib/supabase/server';
import { httpBot, type BotApi } from './bot';
import { savePhoto, transcribeVoice } from './media';
import { handleStranger } from './pairing';
import { deliverPhaseReports } from './phase-reports';
import { supabaseTgStore, type Owner, type TgStore } from './store';
import { runTurn, type TurnDeps } from './turn';
import type { WebhookDeps } from './webhook';
import { MAX_ATTEMPTS, processChat, type WorkerDeps } from './worker';

// Production wiring of the bot: Supabase store, HTTPS Bot API, the real agent.

export function telegramConfigured(): boolean {
  const env = serverEnv();
  return Boolean(env.telegramBotToken && env.telegramWebhookSecret);
}

/** Runs work after the response; a failure is logged, never thrown into the platform. */
function schedule(task: () => Promise<void>): void {
  after(async () => {
    try {
      await task();
    } catch (e) {
      console.error('[telegram] background task failed', (e as Error).message?.slice(0, 200));
    }
  });
}

export type TelegramRuntime = { store: TgStore; bot: BotApi; turn: TurnDeps; worker: WorkerDeps; webhook: WebhookDeps };

export function telegramRuntime(): TelegramRuntime {
  const env = serverEnv();
  const store = supabaseTgStore(supabaseAdmin());
  const bot = httpBot(env.telegramBotToken);
  const turn: TurnDeps = {
    bot, store, appUrl: env.appUrl,
    userClient: async (userId) => supabaseAsUser(await ownerAccessToken(userId)),
    runAgent, savePhoto, transcribeVoice,
  };
  const worker: WorkerDeps = { store, bot, turn: (batch, owner) => runTurn(batch, owner, turn) };
  const webhook: WebhookDeps = {
    store, secret: env.telegramWebhookSecret, schedule,
    process: (chatId, owner) => processChat(chatId, owner, worker),
    ackCallback: async (id) => { await bot.answerCallbackQuery(id).catch(() => undefined); },
    stranger: (c) => handleStranger(c, { store, bot, pairingCode: env.telegramPairingCode, onPaired: async () => { await deliverPhaseReports(supabaseAdmin(), bot); } }),
  };
  return { store, bot, turn, worker, webhook };
}

/** Cron safety net: requeue stuck/failed updates and work through chats nobody picked up. */
export async function retryTelegram(): Promise<number> {
  if (!telegramConfigured()) return 0;
  const rt = telegramRuntime();
  await deliverPhaseReports(supabaseAdmin(), rt.bot).catch((e) => console.error('[telegram] phase reports', (e as Error).message?.slice(0, 120)));
  const chats = await rt.store.requeue(MAX_ATTEMPTS);
  for (const ch of chats) {
    const owner: Owner = { userId: ch.userId, telegramUserId: 0, chatId: ch.chatId };
    await processChat(ch.chatId, owner, rt.worker);
  }
  return chats.length;
}
