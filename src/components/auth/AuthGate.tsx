'use client';

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import type { Session } from '@supabase/supabase-js';
import { supabaseBrowser } from '@/lib/supabase/browser';
import { isBackendConfigured } from '@/lib/env';
import { launchInitData } from '@/lib/client/telegram';

const SessionCtx = createContext<Session | null>(null);
export const useSession = () => useContext(SessionCtx);

type TgAuth = { access_token: string; refresh_token: string } | { error: { message: string } };

/**
 * Inside Telegram the Mini App signs in with the launch data (POST /api/telegram/auth → the owner's
 * ordinary Supabase session, kept in localStorage — cookies do not survive the Telegram Web iframe).
 * Outside Telegram — the password login as before.
 */
async function signInWithTelegram(): Promise<{ session: Session | null; error: string | null }> {
  const initData = launchInitData();
  if (!initData) return { session: null, error: null };
  const res = await fetch('/api/telegram/auth', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ initData }) }).catch(() => null);
  const body = (await res?.json().catch(() => null)) as TgAuth | null;
  if (!res?.ok || !body || 'error' in body) return { session: null, error: (body && 'error' in body && body.error.message) || 'Не удалось войти через Telegram' };
  const { data, error } = await supabaseBrowser().auth.setSession({ access_token: body.access_token, refresh_token: body.refresh_token });
  return { session: data.session, error: error ? error.message : null };
}

export function AuthGate({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [session, setSession] = useState<Session | null | undefined>(() => (isBackendConfigured() ? undefined : null));
  const [tgError, setTgError] = useState<string | null>(null);

  useEffect(() => {
    if (!isBackendConfigured()) return;
    const sb = supabaseBrowser();
    let alive = true;
    void sb.auth.getSession().then(async ({ data }) => {
      if (data.session || !launchInitData()) { if (alive) setSession(data.session); return; }
      const r = await signInWithTelegram();
      if (!alive) return;
      setTgError(r.error);
      setSession(r.session ?? (r.error ? undefined : null));
    });
    const { data: sub } = sb.auth.onAuthStateChange((_e, s) => { if (s || !launchInitData()) setSession(s); });
    return () => { alive = false; sub.subscription.unsubscribe(); };
  }, []);

  useEffect(() => {
    if (session === null && !launchInitData()) router.replace('/login');
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
