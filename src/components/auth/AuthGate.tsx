'use client';

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { isBackendConfigured } from '@/lib/env';
import { onSession, readSession, writeSession, type LiteSession } from '@/lib/client/session';
import { launchInitData } from '@/lib/client/telegram';

const SessionCtx = createContext<LiteSession | null>(null);
export const useSession = () => useContext(SessionCtx);

type TgAuth = LiteSession | { error: { message: string } };

/**
 * Inside Telegram the Mini App signs in with the launch data (POST /api/telegram/auth → the owner's
 * ordinary Supabase session, kept in localStorage — cookies do not survive the Telegram Web iframe).
 * Outside Telegram — the password login as before. No supabase-js here (D31).
 */
async function signInWithTelegram(initData: string): Promise<string | null> {
  const res = await fetch('/api/telegram/auth', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ initData }) }).catch(() => null);
  const body = (await res?.json().catch(() => null)) as TgAuth | null;
  if (!res?.ok || !body || 'error' in body) return (body && 'error' in body && body.error.message) || 'Не удалось войти через Telegram';
  writeSession(body);
  return null;
}

export function AuthGate({ children }: { children: ReactNode }) {
  const router = useRouter();
  // undefined: still deciding; null: signed out.
  const [session, setSession] = useState<LiteSession | null | undefined>(() => (isBackendConfigured() ? undefined : null));
  const [tgError, setTgError] = useState<string | null>(null);

  useEffect(() => {
    if (!isBackendConfigured()) return;
    let alive = true;
    const decide = (s: LiteSession | null) => {
      if (s) { setSession(s); return; }
      const initData = launchInitData();
      if (!initData) { setSession(null); return; }
      void signInWithTelegram(initData).then((error) => { if (alive && error) setTgError(error); });
    };
    // Storage is read after hydration (the server renders «загрузка» too), then kept in sync.
    void Promise.resolve().then(() => { if (alive) decide(readSession()); });
    const off = onSession((s) => { if (alive) decide(s); });
    return () => { alive = false; off(); };
  }, []);

  useEffect(() => {
    if (session === null) router.replace('/login');
  }, [session, router]);

  if (tgError) {
    return (
      <div className="flex min-h-dvh flex-col items-center justify-center gap-3 px-8 text-center">
        <p className="label">вход через telegram</p>
        <p className="text-ink-2">{tgError}</p>
      </div>
    );
  }
  if (!session) {
    return (
      <div className="flex min-h-dvh items-center justify-center">
        <span className="ascii text-ink-3 blink">загрузка</span>
      </div>
    );
  }
  return <SessionCtx.Provider value={session}>{children}</SessionCtx.Provider>;
}
