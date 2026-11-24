'use client';

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import type { Session } from '@supabase/supabase-js';
import { supabaseBrowser } from '@/lib/supabase/browser';
import { isBackendConfigured } from '@/lib/env';

const SessionCtx = createContext<Session | null>(null);
export const useSession = () => useContext(SessionCtx);

export function AuthGate({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [session, setSession] = useState<Session | null | undefined>(undefined);

  useEffect(() => {
    if (!isBackendConfigured()) { setSession(null); return; }
    const sb = supabaseBrowser();
    sb.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: sub } = sb.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (session === null) router.replace('/login');
  }, [session, router]);

  if (!session) {
    return (
      <div className="flex min-h-dvh items-center justify-center">
        <span className="ascii text-ink-3 blink">загрузка</span>
      </div>
    );
  }
  return <SessionCtx.Provider value={session}>{children}</SessionCtx.Provider>;
}
