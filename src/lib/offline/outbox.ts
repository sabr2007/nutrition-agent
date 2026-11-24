'use client';

import { get, set } from 'idb-keyval';

// Offline outbox: writes that fail because the network is down are queued in IndexedDB
// and replayed later. Every queued write carries a client_id, and the server treats
// replays idempotently (save_meal returns the existing row for a known client_id).

export type OutboxEntry = { id: string; url: string; method: 'POST'; body: unknown; createdAt: number; attempts: number };
const KEY = 'ryadom-outbox';

export async function enqueue(entry: Omit<OutboxEntry, 'createdAt' | 'attempts'>): Promise<void> {
  const list = ((await get(KEY)) as OutboxEntry[] | undefined) ?? [];
  await set(KEY, [...list.filter((e) => e.id !== entry.id), { ...entry, createdAt: Date.now(), attempts: 0 }]);
}

export async function pending(): Promise<OutboxEntry[]> {
  return ((await get(KEY)) as OutboxEntry[] | undefined) ?? [];
}

let flushing = false;
export async function flush(send: (e: OutboxEntry) => Promise<Response>): Promise<number> {
  if (flushing) return 0;
  flushing = true;
  let sent = 0;
  try {
    const list = await pending();
    const remaining: OutboxEntry[] = [];
    for (const e of list) {
      try {
        const res = await send(e);
        if (res.ok || (res.status >= 400 && res.status < 500 && res.status !== 401 && res.status !== 408 && res.status !== 429)) sent++;
        else remaining.push({ ...e, attempts: e.attempts + 1 });
      } catch {
        remaining.push({ ...e, attempts: e.attempts + 1 });
      }
    }
    await set(KEY, remaining);
  } finally {
    flushing = false;
  }
  return sent;
}
