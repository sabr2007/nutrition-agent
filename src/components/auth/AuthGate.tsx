'use client';

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { isBackendConfigured } from '@/lib/env';
import { onSession, readSession, type LiteSession } from '@/lib/client/session';
import { launchInitData } from '@/lib/client/telegram';
import { signInWithTelegram } from '@/lib/client/telegram-auth';

const SessionCtx = createContext<LiteSession | null>(null);
export const useSession = () => useContext(SessionCtx);

/**
 * Inside Telegram the Mini App signs in with the launch data (POST /api/telegram/auth → the owner's
 * ordinary Supabase session, kept in localStorage and in the page — D32). Outside Telegram — the
 * password login as before. No supabase-js here (D31).
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const router = useRouter();
  // undefined: still deciding; null: signed out.
  const [session, setSession] = useState<LiteSession | null | undefined>(() => (isBackendConfigured() ? undefined : null));
  const [tgError, setTgError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!isBackendConfigured()) return;
    let alive = true;
    const decide = (s: LiteSession | null) => {
      if (s) { setTgError(null); setSession(s); return; }
      const initData = launchInitData();
      if (!initData) { setSession(null); return; }
      void signInWithTelegram(initData).then((r) => {
        if (!alive) return;
        if (r.ok) { setTgError(null); setSession(r.session); } else setTgError(r.message);
      });
    };
    // Storage is read after hydration (the server renders «загрузка» too), then kept in sync.
    void Promise.resolve().then(() => { if (alive) decide(readSession()); });
    const off = onSession((s) => { if (alive) decide(s); });
    return () => { alive = false; off(); };
  }, [attempt]);

  useEffect(() => {
    if (session === null) router.replace('/login');
  }, [session, router]);

  if (tgError) {
    return (
      <div className="flex min-h-dvh flex-col items-center justify-center gap-4 px-8 text-center">
        <p className="label">вход через telegram</p>
        <p className="text-ink-2">{tgError}</p>
        <button type="button" onClick={() => { setTgError(null); setAttempt((n) => n + 1); }} className="press rounded-full border border-ink px-5 py-2 text-sm">
          Попробовать ещё раз
        </button>
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
