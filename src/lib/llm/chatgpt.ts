import 'server-only';
import { supabaseAdmin } from '@/lib/supabase/server';
import { hasPlanScope, type ConnectPayload } from './chatgpt-connect';
import { decrypt, encrypt } from './crypto';

// "Sign in with ChatGPT" plan usage (docs/research/chatgpt-oauth.md). Tokens arrive from the
// local login CLI (scripts/chatgpt-login.ts) — the documented path for self-hosted
// open-source apps — and are refreshed here, serialized with a lease lock because refresh
// tokens rotate (parallel refreshes fail with refresh_token_reused).

const TOKEN_URL = 'https://auth.openai.com/api/accounts/oauth/token';
const RESOURCE = 'https://api.openai.com/v1';
const TERMINAL = ['invalid_grant', 'invalid_refresh_token', 'token_expired', 'refresh_token_expired', 'refresh_token_invalidated', 'refresh_token_reused'];

type Meta = { client_id?: string; earliest_refresh_at?: string | null; refresh_lease_until?: string | null; last_error?: string | null };

export async function getChatgptToken(userId: string): Promise<string | null> {
  if (process.env.CHATGPT_PLAN_ENABLED !== '1') return null;
  const admin = supabaseAdmin();
  const { data: c } = await admin.from('provider_connections').select('*').eq('user_id', userId).eq('provider', 'chatgpt').eq('status', 'connected').maybeSingle();
  if (!c?.access_token_enc) return null;
  const expiresAt = c.expires_at ? Date.parse(c.expires_at as string) : 0;
  if (expiresAt - Date.now() > 5 * 60_000) return decrypt(c.access_token_enc as string);
  return refresh(userId, c as { id: string; refresh_token_enc: string; meta: Meta; updated_at: string });
}

async function refresh(userId: string, c: { id: string; refresh_token_enc: string; meta: Meta; updated_at: string }): Promise<string | null> {
  const admin = supabaseAdmin();
  const meta = c.meta ?? {};
  const now = Date.now();
  if (meta.refresh_lease_until && Date.parse(meta.refresh_lease_until) > now) return null; // someone else is refreshing
  // Acquire the lease with optimistic concurrency on updated_at.
  const lease = new Date(now + 30_000).toISOString();
  const { data: locked } = await admin.from('provider_connections').update({ meta: { ...meta, refresh_lease_until: lease }, updated_at: new Date().toISOString() })
    .eq('id', c.id).eq('updated_at', c.updated_at).select('id');
  if (!locked?.length || !meta.client_id) return null;
  try {
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', client_id: meta.client_id, refresh_token: decrypt(c.refresh_token_enc), resource: RESOURCE }),
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await res.json().catch(() => ({}))) as { access_token?: string; refresh_token?: string; expires_in?: number; scope?: string; earliest_refresh_at?: string; error?: string };
    if (!res.ok || !body.access_token) {
      const terminal = TERMINAL.includes(body.error ?? '');
      await admin.from('provider_connections').update({ status: terminal ? 'expired' : 'connected', meta: { ...meta, refresh_lease_until: null, last_error: body.error ?? String(res.status) } }).eq('id', c.id);
      return null;
    }
    await admin.from('provider_connections').update({
      access_token_enc: encrypt(body.access_token),
      refresh_token_enc: body.refresh_token ? encrypt(body.refresh_token) : c.refresh_token_enc,
      expires_at: new Date(Date.now() + (body.expires_in ?? 3600) * 1000).toISOString(),
      scope: body.scope ?? null,
      meta: { ...meta, refresh_lease_until: null, earliest_refresh_at: body.earliest_refresh_at ?? null, last_error: null },
    }).eq('id', c.id);
    return body.access_token;
  } catch {
    await admin.from('provider_connections').update({ meta: { ...meta, refresh_lease_until: null } }).eq('id', c.id);
    return null;
  }
}

/** Stores tokens obtained by the local login CLI. Throws if the row was not written. */
export async function saveChatgptTokens(userId: string, t: ConnectPayload): Promise<void> {
  if (!hasPlanScope(t.scope)) throw new Error('scope chatgpt.tokens.use.direct was not granted');
  const { error } = await supabaseAdmin().from('provider_connections').upsert({
    user_id: userId, provider: 'chatgpt', status: 'connected',
    access_token_enc: encrypt(t.access_token), refresh_token_enc: encrypt(t.refresh_token),
    expires_at: new Date(Date.now() + t.expires_in * 1000).toISOString(), scope: t.scope,
    meta: { client_id: t.client_id, earliest_refresh_at: t.earliest_refresh_at ?? null },
  }, { onConflict: 'user_id,provider' });
  // Only the code: PostgREST details can echo row values, and these are tokens.
  if (error) throw new Error(`provider_connections upsert failed (${error.code})`);
}
