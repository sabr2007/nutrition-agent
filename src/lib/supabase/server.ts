import 'server-only';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { publicEnv, serverEnv } from '@/lib/env';

/** Service-role client: bypasses RLS. Only for cron/system tasks; always filter by user_id. */
export function supabaseAdmin(): SupabaseClient {
  const key = serverEnv().supabaseSecretKey;
  if (!key) throw new Error('SUPABASE_SECRET_KEY is not configured');
  return createClient(publicEnv.supabaseUrl, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

/** Client acting as the user (RLS applies) using their access token. */
export function supabaseAsUser(token: string): SupabaseClient {
  return createClient(publicEnv.supabaseUrl, publicEnv.supabasePublishableKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
}
