/**
 * Local "Sign in with ChatGPT" (plan usage) for this self-hosted open-source app.
 * Follows OpenAI's documented OSS flow: dynamic client registration, PKCE S256, loopback
 * redirect on 127.0.0.1 only, then the credentials are transferred to our backend
 * (encrypted in Supabase) — the "self-hosted VM" pattern from the docs.
 *
 *   node --env-file=.env.production.local --conditions=react-server --import tsx scripts/chatgpt-login.ts --email you@example.com
 *
 * Needs: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SECRET_KEY, APP_ENCRYPTION_KEY of the target env.
 * After login set CHATGPT_PLAN_ENABLED=1 in Vercel env and set a weekly cap for the app in
 * ChatGPT → Settings → Usage. See docs/SETUP.md.
 */
import { createServer } from 'node:http';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import { saveChatgptTokens } from '@/lib/llm/chatgpt';

const AUTHORIZE = 'https://auth.openai.com/api/accounts/authorize';
const TOKEN = 'https://auth.openai.com/api/accounts/oauth/token';
const RESOURCE = 'https://api.openai.com/v1';
const SCOPE = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const PORT = 1455;
const STATE_FILE = 'scripts/.chatgpt-client.json'; // gitignored: issued client_id + host id
const b64u = (b: Buffer) => b.toString('base64url');

const email = (() => { const i = process.argv.indexOf('--email'); return i >= 0 ? process.argv[i + 1] : undefined; })();
if (!email) { console.error('--email is required'); process.exit(1); }

const saved = existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, 'utf8')) as { client_id?: string; host_id: string } : { host_id: `urn:uuid:${randomUUID()}` };
const verifier = b64u(randomBytes(48));
const state = b64u(randomBytes(16));
const nonce = b64u(randomBytes(16));
const redirectUri = `http://127.0.0.1:${PORT}/auth/callback`;
const url = `${AUTHORIZE}?${new URLSearchParams({
  response_type: 'code', client_id: saved.client_id ?? 'dynamic_agent_client', redirect_uri: redirectUri, scope: SCOPE, resource: RESOURCE,
  state, nonce, code_challenge_method: 'S256', code_challenge: b64u(createHash('sha256').update(verifier).digest()), ext_agent_host_id: saved.host_id,
})}`;

const server = createServer(async (req, res) => {
  const u = new URL(req.url ?? '/', redirectUri);
  if (u.pathname !== '/auth/callback') { res.writeHead(404).end(); return; }
  try {
    if (u.searchParams.get('state') !== state) throw new Error('state mismatch');
    if (u.searchParams.get('error')) throw new Error(`authorization error: ${u.searchParams.get('error')}`);
    const code = u.searchParams.get('code');
    const clientId = u.searchParams.get('client_id') ?? saved.client_id;
    if (!code || !clientId) throw new Error('missing code or issued client_id');
    writeFileSync(STATE_FILE, JSON.stringify({ client_id: clientId, host_id: saved.host_id }, null, 2));
    const tr = await fetch(TOKEN, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', client_id: clientId, code, code_verifier: verifier, redirect_uri: redirectUri, resource: RESOURCE }) });
    const t = await tr.json() as { access_token?: string; refresh_token?: string; expires_in?: number; scope?: string; earliest_refresh_at?: string; error?: string };
    if (!tr.ok || !t.access_token || !t.refresh_token) throw new Error(`token exchange failed: ${t.error ?? tr.status}`);
    const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SECRET_KEY!, { auth: { persistSession: false } });
    const { data: users } = await admin.auth.admin.listUsers({ page: 1, perPage: 200 });
    const user = users.users.find((x) => x.email?.toLowerCase() === email.toLowerCase());
    if (!user) throw new Error(`user ${email} not found`);
    await saveChatgptTokens(user.id, { access_token: t.access_token, refresh_token: t.refresh_token, expires_in: t.expires_in ?? 3600, scope: t.scope ?? '', client_id: clientId, earliest_refresh_at: t.earliest_refresh_at });
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Готово: ChatGPT подключён к «Рядом». Окно можно закрыть.');
    console.log('✓ ChatGPT plan connected. Now set CHATGPT_PLAN_ENABLED=1 in Vercel env.');
  } catch (e) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' }).end(`Ошибка: ${(e as Error).message}`);
    console.error('✗', (e as Error).message);
  } finally {
    setTimeout(() => process.exit(0), 500);
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('Открой в браузере и подтверди доступ (ссылка действует для этой попытки):\n');
  console.log(url);
});
