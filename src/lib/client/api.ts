'use client';

import { accessToken, writeSession } from '@/lib/client/session';
import type { OutboxEntry } from '@/lib/offline/outbox';

// The offline queue (IndexedDB) loads on demand: the Mini App's first screen never needs it (D31).
const outbox = () => import('@/lib/offline/outbox');
const PENDING_KEY = 'outbox-pending';

/** Event the Today screen listens to (src/lib/client/use-day.ts). */
export const TODAY_REFRESH = 'today:refresh';

/**
 * Tells a mounted Today screen to refetch. Call after any write that changes the day:
 * the Today route can stay mounted between navigations, so it will not refetch on its own.
 */
export function refreshToday(): Promise<unknown> {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(TODAY_REFRESH));
  return Promise.resolve();
}

export class ApiError extends Error {
  constructor(public status: number, message: string, public code?: string) {
    super(message);
  }
}

async function authHeaders(): Promise<Record<string, string>> {
  const token = await accessToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export async function api<T>(path: string, init: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  const res = await fetch(path, {
    method: init.method ?? (init.body ? 'POST' : 'GET'),
    headers: { ...(await authHeaders()), ...(init.body ? { 'Content-Type': 'application/json' } : {}) },
    body: init.body ? JSON.stringify(init.body) : undefined,
    signal: init.signal,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401) writeSession(null);
    throw new ApiError(res.status, (data as { error?: { message?: string } })?.error?.message ?? 'Ошибка сети', (data as { error?: { code?: string } })?.error?.code);
  }
  return data as T;
}

export const fetcher = <T,>(path: string) => api<T>(path);

/** POST that survives being offline: queued in IndexedDB and replayed on reconnect. */
export async function postOrQueue<T>(path: string, body: Record<string, unknown> & { client_id: string }): Promise<{ queued: boolean; data?: T }> {
  try {
    const data = await api<T>(path, { body });
    return { queued: false, data };
  } catch (err) {
    const offline = !navigator.onLine || err instanceof TypeError;
    if (!offline) throw err;
    await (await outbox()).enqueue({ id: body.client_id, url: path, method: 'POST', body });
    try { localStorage.setItem(PENDING_KEY, '1'); } catch { /* the flush also runs on reconnect */ }
    return { queued: true };
  }
}

/** Replays queued writes; a no-op (no IndexedDB, no extra script) when nothing was queued. */
export async function flushOutbox(): Promise<number> {
  try { if (!localStorage.getItem(PENDING_KEY)) return 0; } catch { /* no storage: try the queue */ }
  const { flush, pending } = await outbox();
  const sent = await flush(async (e: OutboxEntry) => fetch(e.url, {
    method: e.method,
    headers: { ...(await authHeaders()), 'Content-Type': 'application/json' },
    body: JSON.stringify(e.body),
  }));
  if (sent > 0) await refreshToday();
  if (!(await pending()).length) { try { localStorage.removeItem(PENDING_KEY); } catch { /* fine */ } }
  return sent;
}

export function newClientId(prefix = 'c'): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}
