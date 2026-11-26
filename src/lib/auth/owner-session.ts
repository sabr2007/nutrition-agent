import 'server-only';
import { createClient } from '@supabase/supabase-js';
import { publicEnv } from '@/lib/env';
import { supabaseAdmin } from '@/lib/supabase/server';

// A real Supabase session for the owner, minted on the server: an admin magic link verified
// right away (no e-mail is sent). Bot turns and the Mini App then use the ordinary user JWT,
// so RLS and auth.uid() work exactly as in the app (D25). The service role never leaves the server.
//
// One account has one live magic link: a second generateLink replaces the first before it is
// verified, and that verify fails with 403 otp_expired (seen in prod when the Mini App signed in
// twice at once, D32). So mints for one user run one at a time in this instance, and a mint that
// lost the race to another instance tries again with a new link.

export type OwnerSession = { access_token: string; refresh_token: string; expires_at: number; expires_in: number; token_type: string; user: { id: string; email?: string } };

/** Reuse a cached access token while it has this much life left. */
const MIN_LIFE_MS = 5 * 60_000;
const MINT_ATTEMPTS = 3;
const RETRY_BASE_MS = 150;
/** A stuck mint must not hold the next one forever. */
const QUEUE_WAIT_MS = 10_000;
const cache = new Map<string, { token: string; expiresAtMs: number }>();
const queue = new Map<string, Promise<unknown>>();

class LinkReplaced extends Error {}

async function mintOnce(userId: string, email: string): Promise<OwnerSession> {
  const { data: link, error: e1 } = await supabaseAdmin().auth.admin.generateLink({ type: 'magiclink', email });
  if (e1 || !link.properties?.hashed_token) throw new Error(`generateLink failed: ${e1?.status ?? 'no token'}`);
  const anon = createClient(publicEnv.supabaseUrl, publicEnv.supabasePublishableKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error: e2 } = await anon.auth.verifyOtp({ type: 'magiclink', token_hash: link.properties.hashed_token });
  if (e2?.code === 'otp_expired' || e2?.status === 403) throw new LinkReplaced('magic link replaced before verify');
  if (e2 || !data.session) throw new Error(`verifyOtp failed: ${e2?.status ?? 'no session'}`);
  if (data.session.user.id !== userId) throw new Error('session user mismatch');
  return data.session as unknown as OwnerSession;
}

async function mint(userId: string): Promise<OwnerSession> {
  const { data: u, error: e0 } = await supabaseAdmin().auth.admin.getUserById(userId);
  if (e0 || !u.user?.email) throw new Error('owner account not found');
  for (let attempt = 1; ; attempt++) {
    try {
      return await mintOnce(userId, u.user.email);
    } catch (err) {
      if (!(err instanceof LinkReplaced) || attempt >= MINT_ATTEMPTS) throw err instanceof LinkReplaced ? new Error('verifyOtp failed: 403') : err;
      await new Promise((r) => setTimeout(r, RETRY_BASE_MS * attempt + Math.floor(Math.random() * RETRY_BASE_MS)));
    }
  }
}

export function mintOwnerSession(userId: string): Promise<OwnerSession> {
  const prev = queue.get(userId) ?? Promise.resolve();
  const turn = new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, QUEUE_WAIT_MS);
    const done = () => { clearTimeout(timer); resolve(); };
    prev.then(done, done);
  });
  const next = turn.then(() => mint(userId));
  queue.set(userId, next);
  void next.catch(() => undefined).finally(() => { if (queue.get(userId) === next) queue.delete(userId); });
  return next;
}

/** An access token for server-side work on the owner's behalf (cached per instance). */
export async function ownerAccessToken(userId: string): Promise<string> {
  const hit = cache.get(userId);
  if (hit && hit.expiresAtMs - Date.now() > MIN_LIFE_MS) return hit.token;
  const s = await mintOwnerSession(userId);
  cache.set(userId, { token: s.access_token, expiresAtMs: s.expires_at * 1000 });
  return s.access_token;
}
