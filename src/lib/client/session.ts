'use client';

import { publicEnv } from '@/lib/env';

// The signed-in session without supabase-js (D31): the shared app shell only needs the access
// token for our own API, and supabase-js is 62 KB gzip on every screen. The session lives where
// supabase-js keeps it (localStorage 'ryadom-auth', same shape), so the pages that still query
// tables directly (settings, body, memory, login) share it. Refreshes take the same Web Lock as
// supabase-js ('lock:ryadom-auth'), so the two never spend one refresh token twice.
//
// The page also keeps its own copy (D32): Telegram's webview on the Mac lost the stored session
// five seconds after sign-in, with nothing in the app removing it. Storage stays the source of
// truth when it holds a session (another tab or supabase-js may have refreshed it); when it
// loses one, the page's copy keeps the visit going and is written back.

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

let pageCopy: LiteSession | null = null;
let restoredFromPage = false;

function readStored(): LiteSession | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as Partial<LiteSession>;
    return s.access_token && s.refresh_token && s.user?.id && typeof s.expires_at === 'number' ? (s as LiteSession) : null;
  } catch {
    return null;
  }
}

function store(s: LiteSession | null): void {
  try {
    if (s) localStorage.setItem(KEY, JSON.stringify(s));
    else localStorage.removeItem(KEY);
  } catch {
    // storage unavailable: the page's copy carries the visit
  }
}

export function readSession(): LiteSession | null {
  const stored = readStored();
  if (stored && (!pageCopy || stored.expires_at >= pageCopy.expires_at)) {
    pageCopy = stored;
    return stored;
  }
  if (pageCopy && !stored) {
    restoredFromPage = true;
    store(pageCopy); // supabase-js (body, settings) reads storage directly
  }
  return pageCopy;
}

/** True once this page had to put a lost session back (sent to the API as a diagnostic). */
export const sessionRestored = (): boolean => restoredFromPage;

export function writeSession(s: LiteSession | null): void {
  pageCopy = s;
  store(s);
  for (const l of listeners) l(s);
}

/** Changes from this tab (writeSession) and from others (storage events). */
export function onSession(l: Listener): () => void {
  listeners.add(l);
  const onStorage = (e: StorageEvent) => {
    if (e.key !== KEY) return;
    if (e.newValue === null) pageCopy = null; // another tab signed out: so does this one
    l(readSession());
  };
  window.addEventListener('storage', onStorage);
  return () => { listeners.delete(l); window.removeEventListener('storage', onStorage); };
}

async function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const locks = (navigator as Navigator & { locks?: LockManager }).locks;
  return locks ? locks.request(LOCK, fn) : fn();
}

const fresh = (s: LiteSession) => s.expires_at * 1000 - Date.now() > EARLY_MS;

/**
 * Trades the refresh token for a new session. `force` refreshes even a token that looks fresh
 * (the API just refused it), unless another caller already replaced it while we waited.
 */
async function refresh(force = false, staleToken?: string): Promise<LiteSession | null> {
  return withLock(async () => {
    const cur = readSession(); // another tab or supabase-js may have refreshed while we waited
    if (!cur) return null;
    if (force ? cur.access_token !== staleToken : fresh(cur)) return cur;
    let res: Response;
    try {
      res = await fetch(`${publicEnv.supabaseUrl}/auth/v1/token?grant_type=refresh_token`, {
        method: 'POST', headers: { apikey: publicEnv.supabasePublishableKey, 'Content-Type': 'application/json' }, body: JSON.stringify({ refresh_token: cur.refresh_token }),
      });
    } catch {
      return force ? null : cur; // offline: keep the session, the request will tell
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

/** After the API refused `staleToken`: a refreshed session, or null when the grant is gone. */
export function refreshAfterRejection(staleToken: string): Promise<LiteSession | null> {
  return refresh(true, staleToken);
}
