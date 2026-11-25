import 'server-only';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { serverEnv } from '@/lib/env';
import { decrypt, encrypt } from '@/lib/llm/crypto';
import { supabaseAdmin } from '@/lib/supabase/server';

// Google Health OAuth (D28): an ordinary server-side web flow. The owner starts it from the Mini
// App (opened in the external browser — Google blocks OAuth in embedded webviews); `state` is
// signed and carries the user id, so the callback needs no session. Tokens are encrypted like the
// ChatGPT ones (AES-256-GCM) and refreshed under a lease.

export const PROVIDER = 'google_health';
export const SCOPES = [
  'https://www.googleapis.com/auth/googlehealth.activity_and_fitness.readonly',
  'https://www.googleapis.com/auth/googlehealth.health_metrics_and_measurements.readonly',
  'https://www.googleapis.com/auth/googlehealth.sleep.readonly',
  'https://www.googleapis.com/auth/googlehealth.settings.readonly',
];
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
export const API = 'https://health.googleapis.com/v4/users/me';
const STATE_TTL_MS = 15 * 60_000;
const REFRESH_MARGIN_MS = 5 * 60_000;
const LEASE_MS = 30_000;

export const redirectUri = () => `${serverEnv().appUrl}/api/health/google/callback`;
export const googleConfigured = () => Boolean(serverEnv().googleClientId && serverEnv().googleClientSecret);

function stateKey(): Buffer {
  return createHmac('sha256', Buffer.from(serverEnv().encryptionKey, 'base64')).update('google-health-state-v1').digest();
}

/** `<payload>.<hmac>` with the user id and an expiry. */
export function signState(userId: string, now = Date.now()): string {
  const payload = Buffer.from(JSON.stringify({ u: userId, e: now + STATE_TTL_MS, n: randomBytes(8).toString('hex') })).toString('base64url');
  return `${payload}.${createHmac('sha256', stateKey()).update(payload).digest('base64url')}`;
}

export function verifyState(state: string, now = Date.now()): string | null {
  const [payload, sig] = state.split('.');
  if (!payload || !sig) return null;
  const want = createHmac('sha256', stateKey()).update(payload).digest();
  const got = Buffer.from(sig, 'base64url');
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  try {
    const { u, e } = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { u?: string; e?: number };
    return u && e && e > now ? u : null;
  } catch {
    return null;
  }
}

export function authUrl(userId: string): string {
  const q = new URLSearchParams({
    client_id: serverEnv().googleClientId, redirect_uri: redirectUri(), response_type: 'code', scope: SCOPES.join(' '),
    access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true', state: signState(userId),
  });
  return `${AUTH_URL}?${q}`;
}

type TokenBody = { access_token?: string; refresh_token?: string; expires_in?: number; refresh_token_expires_in?: number; scope?: string; error?: string; error_description?: string };

async function tokenRequest(params: Record<string, string>): Promise<TokenBody & { status: number }> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: serverEnv().googleClientId, client_secret: serverEnv().googleClientSecret, ...params }),
    signal: AbortSignal.timeout(15_000),
  });
  return { ...((await res.json().catch(() => ({}))) as TokenBody), status: res.status };
}

export type ConnectResult = { ok: true } | { ok: false; reason: 'not_linked' | 'legacy_fitbit' | 'token' | 'scope'; detail?: string };

/** Code → tokens → identity check → encrypted connection row. */
export async function connectWithCode(userId: string, code: string): Promise<ConnectResult> {
  const t = await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: redirectUri() });
  if (!t.access_token || !t.refresh_token) return { ok: false, reason: 'token', detail: t.error ?? String(t.status) };
  const granted = (t.scope ?? '').split(' ');
  if (!SCOPES.slice(0, 3).some((s) => granted.includes(s))) return { ok: false, reason: 'scope' };
  const id = await fetch(`${API}/identity`, { headers: { Authorization: `Bearer ${t.access_token}` }, signal: AbortSignal.timeout(15_000) });
  const idBody = (await id.json().catch(() => ({}))) as { healthUserId?: string; error?: { status?: string; details?: { reason?: string }[] } };
  if (!id.ok) {
    const reason = idBody.error?.details?.find((d) => d.reason)?.reason;
    return { ok: false, reason: reason === 'ACCOUNT_NOT_LINKED' ? 'not_linked' : id.status === 403 ? 'legacy_fitbit' : 'token', detail: `${id.status}` };
  }
  const now = Date.now();
  const { error } = await supabaseAdmin().from('provider_connections').upsert({
    user_id: userId, provider: PROVIDER, status: 'connected',
    access_token_enc: encrypt(t.access_token), refresh_token_enc: encrypt(t.refresh_token),
    expires_at: new Date(now + (t.expires_in ?? 3600) * 1000).toISOString(), scope: t.scope ?? null,
    meta: {
      health_user_id: idBody.healthUserId ?? null, connected_at: new Date(now).toISOString(),
      refresh_expires_at: t.refresh_token_expires_in ? new Date(now + t.refresh_token_expires_in * 1000).toISOString() : null,
    },
    updated_at: new Date(now).toISOString(),
  }, { onConflict: 'user_id,provider' });
  if (error) throw new Error(`provider_connections upsert failed (${error.code})`);
  return { ok: true };
}

type Conn = { id: string; status: string; access_token_enc: string | null; refresh_token_enc: string; expires_at: string | null; meta: Record<string, unknown>; updated_at: string };

export async function readConnection(admin: SupabaseClient, userId: string): Promise<Conn | null> {
  const { data } = await admin.from('provider_connections').select('id, status, access_token_enc, refresh_token_enc, expires_at, meta, updated_at').eq('user_id', userId).eq('provider', PROVIDER).maybeSingle();
  return (data as Conn | null) ?? null;
}

/** A valid access token, refreshed when needed; null when not connected or the grant is gone. */
export async function googleToken(userId: string): Promise<string | null> {
  const admin = supabaseAdmin();
  const c = await readConnection(admin, userId);
  if (!c || c.status !== 'connected' || !c.access_token_enc) return null;
  const left = (c.expires_at ? Date.parse(c.expires_at) : 0) - Date.now();
  if (left > REFRESH_MARGIN_MS) return decrypt(c.access_token_enc);
  const meta = c.meta ?? {};
  if (meta.refresh_lease_until && Date.parse(String(meta.refresh_lease_until)) > Date.now()) return left > 15_000 ? decrypt(c.access_token_enc) : null;
  const { data: locked } = await admin.from('provider_connections').update({ meta: { ...meta, refresh_lease_until: new Date(Date.now() + LEASE_MS).toISOString() }, updated_at: new Date().toISOString() })
    .eq('id', c.id).eq('updated_at', c.updated_at).select('id');
  if (!locked?.length) return left > 15_000 ? decrypt(c.access_token_enc) : null;
  const t = await tokenRequest({ grant_type: 'refresh_token', refresh_token: decrypt(c.refresh_token_enc) });
  if (!t.access_token) {
    const terminal = t.error === 'invalid_grant';
    await admin.from('provider_connections').update({ status: terminal ? 'expired' : 'connected', meta: { ...meta, refresh_lease_until: null, last_error: t.error ?? String(t.status) } }).eq('id', c.id);
    return null;
  }
  await admin.from('provider_connections').update({
    access_token_enc: encrypt(t.access_token), ...(t.refresh_token ? { refresh_token_enc: encrypt(t.refresh_token) } : {}),
    expires_at: new Date(Date.now() + (t.expires_in ?? 3600) * 1000).toISOString(),
    meta: { ...meta, refresh_lease_until: null, last_error: null },
  }).eq('id', c.id);
  return t.access_token;
}

/** Revokes the grant at Google and forgets the tokens. */
export async function disconnect(userId: string): Promise<void> {
  const admin = supabaseAdmin();
  const c = await readConnection(admin, userId);
  if (!c) return;
  const token = c.refresh_token_enc ? decrypt(c.refresh_token_enc) : null;
  if (token) {
    await fetch(REVOKE_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token }), signal: AbortSignal.timeout(10_000) }).catch(() => null);
  }
  await admin.from('provider_connections').update({ status: 'revoked', access_token_enc: null, meta: { ...c.meta, revoked_at: new Date().toISOString() } }).eq('id', c.id);
}
