'use client';

import { publicEnv } from '@/lib/env';

// The signed-in session without supabase-js (D31): the shared app shell only needs the access
// token for our own API, and supabase-js is 62 KB gzip on every screen. The session lives where
// supabase-js keeps it (localStorage 'ryadom-auth', same shape), so the pages that still query
// tables directly (settings, body, memory, login) share it. Refreshes take the same Web Lock as
// supabase-js ('lock:ryadom-auth'), so the two never spend one refresh token twice.

export type LiteSession = {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  expires_in?: number;
  token_type?: string;
  user: { id: string; email?: string | null };
};

const KEY = 'ryadom-auth';
const LOCK = `lock:${KEY}`;
/** Refresh a minute before the token expires. */
const EARLY_MS = 60_000;

type Listener = (s: LiteSession | null) => void;
const listeners = new Set<Listener>();

export function readSession(): LiteSession | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as Partial<LiteSession>;
    return s.access_token && s.refresh_token && s.user?.id && typeof s.expires_at === 'number' ? (s as LiteSession) : null;
  } catch {
    return null;
  }
}

export function writeSession(s: LiteSession | null): void {
  try {
    if (s) localStorage.setItem(KEY, JSON.stringify(s));
    else localStorage.removeItem(KEY);
  } catch {
    // storage unavailable: the session lives for this page only
  }
  for (const l of listeners) l(s);
}

/** Changes from this tab (writeSession) and from others (storage events). */
export function onSession(l: Listener): () => void {
  listeners.add(l);
  const onStorage = (e: StorageEvent) => { if (e.key === KEY) l(readSession()); };
  window.addEventListener('storage', onStorage);
  return () => { listeners.delete(l); window.removeEventListener('storage', onStorage); };
}

async function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const locks = (navigator as Navigator & { locks?: LockManager }).locks;
  return locks ? locks.request(LOCK, fn) : fn();
}

const fresh = (s: LiteSession) => s.expires_at * 1000 - Date.now() > EARLY_MS;

async function refresh(): Promise<LiteSession | null> {
  return withLock(async () => {
    const cur = readSession(); // another tab or supabase-js may have refreshed while we waited
    if (!cur || fresh(cur)) return cur;
    let res: Response;
    try {
      res = await fetch(`${publicEnv.supabaseUrl}/auth/v1/token?grant_type=refresh_token`, {
        method: 'POST', headers: { apikey: publicEnv.supabasePublishableKey, 'Content-Type': 'application/json' }, body: JSON.stringify({ refresh_token: cur.refresh_token }),
      });
    } catch {
      return cur; // offline: keep the session, the request will tell
    }
    if (!res.ok) {
      if (res.status === 400 || res.status === 401) writeSession(null); // the grant is gone
      return null;
    }
    const s = (await res.json()) as LiteSession;
    const next: LiteSession = { ...s, expires_at: s.expires_at ?? Math.floor(Date.now() / 1000) + (s.expires_in ?? 3600) };
    writeSession(next);
    return next;
  });
}

let refreshing: Promise<LiteSession | null> | null = null;

/** A valid access token (refreshed when close to expiry), or null when signed out. */
export async function accessToken(): Promise<string | null> {
  const s = readSession();
  if (!s) return null;
  if (fresh(s)) return s.access_token;
  refreshing ??= refresh().finally(() => { refreshing = null; });
  return (await refreshing)?.access_token ?? null;
}
