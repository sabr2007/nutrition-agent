/**
 * Local "Sign in with ChatGPT" (plan usage) for this self-hosted open-source app.
 * Follows OpenAI's documented OSS flow: dynamic client registration, PKCE S256, loopback
 * redirect on 127.0.0.1 only, then the credentials are transferred to our backend — the
 * "self-hosted VM" pattern from the docs. The backend encrypts them with its own key, so
 * this script needs no server secrets: you sign in to «Рядом» with your app password.
 *
 *   node --env-file=.env.production.local --import tsx scripts/chatgpt-login.ts --email LOGIN
 *
 * Needs only public values: NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
 * APP_URL (defaults to the production URL). After login set CHATGPT_PLAN_ENABLED=1 in Vercel
 * env and a weekly cap for the app in ChatGPT → Settings → Usage. See docs/SETUP.md.
 */
import { createServer } from 'node:http';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { createClient } from '@supabase/supabase-js';

const AUTHORIZE = 'https://auth.openai.com/api/accounts/authorize';
const TOKEN = 'https://auth.openai.com/api/accounts/oauth/token';
const RESOURCE = 'https://api.openai.com/v1';
const SCOPE = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const PORT = 1455;
const STATE_FILE = 'scripts/.chatgpt-client.json'; // gitignored: issued client_id + host id
// Shown on the consent screen at first registration; the same name for every installation.
const AGENT_NAME = 'Рядом';
const PLAN_SCOPE = 'chatgpt.tokens.use.direct';
const DEFAULT_APP_URL = 'https://ryadom-coach.vercel.app';
const b64u = (b: Buffer) => b.toString('base64url');

/** Reads a line from the terminal without echoing it. */
function askHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const out = rl as unknown as { _writeToOutput: (s: string) => void; output: NodeJS.WriteStream };
    process.stdout.write(question);
    out._writeToOutput = (s: string) => { if (s.includes('\n')) out.output.write('\n'); };
    rl.question('', (answer) => { rl.close(); resolve(answer); });
  });
}

const email = (() => { const i = process.argv.indexOf('--email'); return i >= 0 ? process.argv[i + 1] : undefined; })();
if (!email) { console.error('--email is required (your «Рядом» login)'); process.exit(1); }
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
const appUrl = (process.env.APP_URL || DEFAULT_APP_URL).replace(/\/$/, '');
if (!supabaseUrl || !publishableKey) { console.error('NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY are required (vercel env pull)'); process.exit(1); }

// 1. Sign in to «Рядом» first, so a wrong password fails before the OpenAI consent.
const password = await askHidden(`Пароль от «Рядом» для ${email}: `);
const app = createClient(supabaseUrl, publishableKey, { auth: { persistSession: false, autoRefreshToken: false } });
const { data: session, error: signInError } = await app.auth.signInWithPassword({ email, password });
if (signInError || !session.session) { console.error(`✗ Не удалось войти в «Рядом»: ${signInError?.message ?? 'нет сессии'}`); process.exit(1); }
const appToken = session.session.access_token;
console.log('✓ Вошёл в «Рядом».');

// 2. OAuth with OpenAI on the loopback address.
const saved = existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, 'utf8')) as { client_id?: string; host_id: string } : { host_id: `urn:uuid:${randomUUID()}` };
// The host id must be chosen and persisted before the first sign-in (retries reuse it).
if (!existsSync(STATE_FILE)) writeFileSync(STATE_FILE, JSON.stringify({ host_id: saved.host_id }, null, 2));
const firstRegistration = !saved.client_id;
const verifier = b64u(randomBytes(48));
const state = b64u(randomBytes(16));
const nonce = b64u(randomBytes(16));
const redirectUri = `http://127.0.0.1:${PORT}/auth/callback`;
const url = `${AUTHORIZE}?${new URLSearchParams({
  response_type: 'code', client_id: saved.client_id ?? 'dynamic_agent_client', redirect_uri: redirectUri, scope: SCOPE, resource: RESOURCE,
  state, nonce, code_challenge_method: 'S256', code_challenge: b64u(createHash('sha256').update(verifier).digest()), ext_agent_host_id: saved.host_id,
  ...(firstRegistration ? { agent_name_hint: AGENT_NAME } : {}),
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
    // A valid sign-in alone does not allow plan usage: the granted scopes must include it.
    if (!(t.scope ?? '').split(' ').includes(PLAN_SCOPE)) throw new Error('ChatGPT plan usage was not granted (consent declined or unavailable for this account)');

    // 3. Hand the credentials to the backend, which encrypts and stores them.
    const sr = await fetch(`${appUrl}/api/providers/chatgpt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${appToken}` },
      body: JSON.stringify({ access_token: t.access_token, refresh_token: t.refresh_token, expires_in: t.expires_in ?? 3600, scope: t.scope ?? '', client_id: clientId, earliest_refresh_at: t.earliest_refresh_at ?? null }),
    });
    if (!sr.ok) {
      const body = await sr.json().catch(() => null) as { error?: { message?: string } } | null;
      throw new Error(`«Рядом» не сохранил токены: ${body?.error?.message ?? sr.status}`);
    }
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
