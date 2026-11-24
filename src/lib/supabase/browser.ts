'use client';

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { publicEnv } from '@/lib/env';

let client: SupabaseClient | null = null;

/** Browser Supabase client. Session lives in localStorage of the installed PWA. */
export function supabaseBrowser(): SupabaseClient {
  if (!client) {
    client = createClient(publicEnv.supabaseUrl, publicEnv.supabasePublishableKey, {
      auth: { persistSession: true, autoRefreshToken: true, storageKey: 'ryadom-auth', detectSessionInUrl: false },
    });
  }
  return client;
}

/** Access token for calling our own API routes. */
export async function accessToken(): Promise<string | null> {
  const { data } = await supabaseBrowser().auth.getSession();
  return data.session?.access_token ?? null;
}
