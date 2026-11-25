import { createHash, timingSafeEqual } from 'node:crypto';
import type { BotApi } from './bot';
import type { Classified } from './update';
import type { TgStore } from './store';
import { HELP_HTML } from './texts';

// Pairing: the first «/start <code>» with the code from TELEGRAM_PAIRING_CODE links the owner's
// Telegram account. The code works once (its hash is stored) and only while nobody is linked.
// Everyone else gets one short refusal — at most once a minute, without any model call.

export const REFUSAL = 'Это личный бот «Рядом»: он отвечает только своему владельцу.';
const REFUSAL_GAP_MS = 60_000;
const ATTEMPTS_PER_HOUR = 5;
const attempts = new Map<number, number[]>();

export type StrangerDeps = { store: TgStore; bot: BotApi; pairingCode: string; now?: () => Date };

export const codeHash = (code: string) => createHash('sha256').update(code.trim()).digest('hex');

function attemptAllowed(fromId: number, now: number): boolean {
  const recent = (attempts.get(fromId) ?? []).filter((t) => now - t < 3600_000);
  if (recent.length >= ATTEMPTS_PER_HOUR) return false;
  attempts.set(fromId, [...recent, now]);
  return true;
}

export async function tryPair(c: Classified, deps: StrangerDeps): Promise<'paired' | 'rejected'> {
  const code = c.command?.arg.trim() ?? '';
  const now = (deps.now?.() ?? new Date()).getTime();
  if (!deps.pairingCode || !code || c.fromId == null || c.chatId == null || !attemptAllowed(c.fromId, now)) return 'rejected';
  const got = Buffer.from(codeHash(code), 'hex');
  const want = Buffer.from(codeHash(deps.pairingCode), 'hex');
  if (!timingSafeEqual(got, want)) return 'rejected';
  const hash = codeHash(code);
  if (await deps.store.pairingUsed(hash)) return 'rejected';
  const owner = await deps.store.ownerProfile();
  if (!owner || owner.telegramUserId != null) return 'rejected';
  await deps.store.linkTelegram(owner.userId, c.fromId, c.chatId, hash);
  await deps.bot.sendMessage(c.chatId, `Готово: бот привязан к твоему «Рядом».\n\n${HELP_HTML}`, { parse_mode: 'HTML' });
  return 'paired';
}

/** A message from someone who is not the linked owner. */
export async function handleStranger(c: Classified, deps: StrangerDeps): Promise<void> {
  if (c.chatId == null) return;
  if (c.kind === 'command' && c.command?.name === 'start' && c.command.arg) {
    if ((await tryPair(c, deps)) === 'paired') return;
  }
  const now = deps.now?.() ?? new Date();
  const state = await deps.store.chatState(c.chatId);
  if (state.lastRefusalAt && now.getTime() - Date.parse(state.lastRefusalAt) < REFUSAL_GAP_MS) return;
  await deps.store.setChatState(c.chatId, { lastRefusalAt: now.toISOString() });
  await deps.bot.sendMessage(c.chatId, REFUSAL);
}
