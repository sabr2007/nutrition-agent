'use client';

import { mutate } from 'swr';
import { accessToken, supabaseBrowser } from '@/lib/supabase/browser';
import { enqueue, flush, type OutboxEntry } from '@/lib/offline/outbox';

/**
 * Revalidates every cached Today snapshot. Call after any write that changes the day:
 * the Today route can stay mounted between navigations, so it will not refetch on its own.
 */
export function refreshToday(): Promise<unknown> {
  return mutate((key) => typeof key === 'string' && key.startsWith('/api/today'));
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
    if (res.status === 401) await supabaseBrowser().auth.signOut().catch(() => undefined);
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
    await enqueue({ id: body.client_id, url: path, method: 'POST', body });
    return { queued: true };
  }
}

export async function flushOutbox(): Promise<number> {
  const sent = await flush(async (e: OutboxEntry) => fetch(e.url, {
    method: e.method,
    headers: { ...(await authHeaders()), 'Content-Type': 'application/json' },
    body: JSON.stringify(e.body),
  }));
  if (sent > 0) await refreshToday();
  return sent;
}

export function newClientId(prefix = 'c'): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}
