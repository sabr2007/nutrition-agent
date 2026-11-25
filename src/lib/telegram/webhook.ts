import { createHash, timingSafeEqual } from 'node:crypto';
import { classify, type Classified } from './update';
import type { TgUpdate } from './types';
import type { Owner, TgStore } from './store';

// POST /api/telegram/webhook: check the secret header, store the update once (update_id is
// unique — Telegram retries), answer 200 at once and do the work after the response.

export type WebhookDeps = {
  store: TgStore;
  secret: string;
  /** Runs work after the response (next/server `after`). */
  schedule: (task: () => Promise<void>) => void;
  /** Works through the chat's queue (one worker per chat). */
  process: (chatId: number, owner: Owner) => Promise<void>;
  /** Stops the button spinner right away; the action itself waits its turn in the queue. */
  ackCallback: (callbackId: string) => Promise<void>;
  /** Someone who is not the owner: a pairing attempt or a refusal, never the model. */
  stranger: (c: Classified) => Promise<void>;
};

const sha = (s: string) => createHash('sha256').update(s).digest();

/** Constant-time comparison of the secret header. */
export function secretMatches(got: string | null, expected: string): boolean {
  if (!got || !expected) return false;
  return timingSafeEqual(sha(got), sha(expected));
}

const ok = () => new Response('ok', { status: 200 });

export async function handleWebhook(req: Request, deps: WebhookDeps): Promise<Response> {
  if (!secretMatches(req.headers.get('x-telegram-bot-api-secret-token'), deps.secret)) return new Response('unauthorized', { status: 401 });
  let update: TgUpdate | null = null;
  try {
    update = (await req.json()) as TgUpdate;
  } catch {
    return ok();
  }
  if (!update || typeof update.update_id !== 'number') return ok();
  const c = classify(update);
  if (c.chatId == null || c.fromId == null) {
    await deps.store.insertUpdate({ update_id: c.updateId, chat_id: c.chatId, user_id: null, kind: 'other', payload: {}, status: 'ignored' });
    return ok();
  }
  const owner = await deps.store.findOwnerByTelegram(c.fromId);
  if (!owner) {
    // Not the owner: nothing of the message is kept and no model is called.
    const fresh = await deps.store.insertUpdate({ update_id: c.updateId, chat_id: c.chatId, user_id: null, kind: 'foreign', payload: {}, status: 'ignored' });
    if (fresh) deps.schedule(() => deps.stranger(c));
    return ok();
  }
  if (c.kind === 'other') {
    await deps.store.insertUpdate({ update_id: c.updateId, chat_id: c.chatId, user_id: owner.userId, kind: 'other', payload: {}, status: 'ignored' });
    return ok();
  }
  const fresh = await deps.store.insertUpdate({
    update_id: c.updateId, chat_id: c.chatId, user_id: owner.userId, kind: c.kind, media_group_id: c.mediaGroupId ?? null, payload: update, status: 'received',
  });
  if (!fresh) return ok();
  if (c.callback) {
    const callbackId = c.callback.id;
    deps.schedule(() => deps.ackCallback(callbackId));
  }
  const chatId = c.chatId;
  deps.schedule(() => deps.process(chatId, owner));
  return ok();
}
