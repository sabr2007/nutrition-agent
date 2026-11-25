import type { BotApi } from './bot';
import type { Owner, StoredUpdate, TgStore } from './store';
import { GAVE_UP_NOTICE, RETRY_NOTICE } from './texts';

// One worker per chat (a lease in tg_chats): updates of a chat are handled strictly one after
// another; a message that arrives mid-turn waits in tg_updates and is picked up next.
// Album photos (media_group_id) are collected for a short quiet window and handled as one turn.

export const LEASE_S = 330;
export const MAX_ATTEMPTS = 3;
const MAX_TURNS_PER_RUN = 8;
const MAX_REENTRY = 2;
export const MAX_ALBUM_PHOTOS = 4;

export type WorkerDeps = {
  store: TgStore;
  bot: BotApi;
  turn: (batch: StoredUpdate[], owner: Owner) => Promise<{ runId?: string | null }>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Quiet time after the last album photo before the album is handled. */
  albumWindowMs?: number;
  /** Longest wait for an album to complete. */
  albumMaxWaitMs?: number;
};

const holderId = () => `w${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

async function collectAlbum(chatId: number, first: StoredUpdate, deps: WorkerDeps): Promise<StoredUpdate[]> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const now = deps.now ?? Date.now;
  const windowMs = deps.albumWindowMs ?? 1500;
  const deadline = now() + (deps.albumMaxWaitMs ?? 5000);
  const group = first.media_group_id!;
  while (now() < deadline) {
    const last = await deps.store.latestGroupArrival(chatId, group);
    const quiet = last ? now() - Date.parse(last) : windowMs;
    if (quiet >= windowMs) break;
    await sleep(Math.min(windowMs - quiet + 50, 1000));
  }
  const rest = await deps.store.claimGroup(chatId, group);
  return [first, ...rest].sort((a, b) => a.update_id - b.update_id);
}

async function runBatch(chatId: number, batch: StoredUpdate[], owner: Owner, deps: WorkerDeps): Promise<void> {
  try {
    const r = await deps.turn(batch, owner);
    for (const u of batch) await deps.store.finishUpdate(u.update_id, { status: 'done', runId: r.runId ?? null });
  } catch (e) {
    const error = String((e as Error)?.message ?? e).slice(0, 300);
    for (const u of batch) await deps.store.finishUpdate(u.update_id, { status: 'failed', error });
    const attempts = Math.max(...batch.map((u) => u.attempts));
    const notice = attempts >= MAX_ATTEMPTS ? GAVE_UP_NOTICE : attempts === 1 ? RETRY_NOTICE : null;
    if (notice) await deps.bot.sendMessage(chatId, notice).catch(() => undefined);
    console.error('[telegram] turn failed', { attempts, error: error.slice(0, 120) });
  }
}

/** Works through the chat's waiting updates; returns at once if another worker holds the chat. */
export async function processChat(chatId: number, owner: Owner, deps: WorkerDeps, depth = 0): Promise<void> {
  const holder = holderId();
  if (!(await deps.store.acquireChat(chatId, holder, LEASE_S))) return;
  try {
    for (let i = 0; i < MAX_TURNS_PER_RUN; i++) {
      const next = await deps.store.claimNext(chatId);
      if (!next) break;
      let batch = next.media_group_id ? await collectAlbum(chatId, next, deps) : [next];
      if (batch.length > MAX_ALBUM_PHOTOS) {
        // The agent sees up to four photos; the rest of the album is acknowledged without a turn.
        for (const extra of batch.slice(MAX_ALBUM_PHOTOS)) await deps.store.finishUpdate(extra.update_id, { status: 'done', error: 'album: over 4 photos' });
        batch = batch.slice(0, MAX_ALBUM_PHOTOS);
      }
      await deps.store.acquireChat(chatId, holder, LEASE_S);
      await runBatch(chatId, batch, owner, deps);
    }
  } finally {
    await deps.store.releaseChat(chatId, holder).catch(() => undefined);
  }
  // A message may have landed between the last claim and the release.
  if (depth < MAX_REENTRY && (await deps.store.hasWaiting(chatId))) await processChat(chatId, owner, deps, depth + 1);
}
