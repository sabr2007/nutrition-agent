import 'server-only';
import { createClient } from '@supabase/supabase-js';
import { publicEnv } from '@/lib/env';
import { supabaseAdmin } from '@/lib/supabase/server';

// A real Supabase session for the owner, minted on the server: an admin magic link verified
// right away (no e-mail is sent). Bot turns and the Mini App then use the ordinary user JWT,
// so RLS and auth.uid() work exactly as in the app (D25). The service role never leaves the server.

export type OwnerSession = { access_token: string; refresh_token: string; expires_at: number; expires_in: number; token_type: string; user: { id: string } };

/** Reuse a cached access token while it has this much life left. */
const MIN_LIFE_MS = 5 * 60_000;
const cache = new Map<string, { token: string; expiresAtMs: number }>();

export async function mintOwnerSession(userId: string): Promise<OwnerSession> {
  const admin = supabaseAdmin();
  const { data: u, error: e0 } = await admin.auth.admin.getUserById(userId);
  if (e0 || !u.user?.email) throw new Error('owner account not found');
  const { data: link, error: e1 } = await admin.auth.admin.generateLink({ type: 'magiclink', email: u.user.email });
  if (e1 || !link.properties?.hashed_token) throw new Error(`generateLink failed: ${e1?.status ?? 'no token'}`);
  const anon = createClient(publicEnv.supabaseUrl, publicEnv.supabasePublishableKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error: e2 } = await anon.auth.verifyOtp({ type: 'magiclink', token_hash: link.properties.hashed_token });
  if (e2 || !data.session) throw new Error(`verifyOtp failed: ${e2?.status ?? 'no session'}`);
  if (data.session.user.id !== userId) throw new Error('session user mismatch');
  return data.session as unknown as OwnerSession;
}

/** An access token for server-side work on the owner's behalf (cached per instance). */
export async function ownerAccessToken(userId: string): Promise<string> {
  const hit = cache.get(userId);
  if (hit && hit.expiresAtMs - Date.now() > MIN_LIFE_MS) return hit.token;
  const s = await mintOwnerSession(userId);
  cache.set(userId, { token: s.access_token, expiresAtMs: s.expires_at * 1000 });
  return s.access_token;
}
