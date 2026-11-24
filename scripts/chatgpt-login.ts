/**
 * Local "Sign in with ChatGPT" (plan usage) for this self-hosted open-source app.
 * Follows OpenAI's documented OSS flow: dynamic client registration, PKCE S256, loopback
 * redirect on 127.0.0.1 only, then the credentials are transferred to our backend — the
 * "self-hosted VM" pattern from the docs. The backend encrypts them with its own key, so
 * this script needs no server secrets: you sign in to «Рядом» with your app password.
 *
 *   node --env-file=.env.production.local --import tsx scripts/chatgpt-login.ts --email LOGIN [--app-url URL]
 *
 * Needs only public values: NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY.
 * The app URL comes from --app-url, then APP_URL, then the production default; the
 * "[SENSITIVE]" placeholders written by `vercel env pull` are ignored. Before the browser step
 * the script checks that the app accepts the login and can store tokens. If the hand-off still
 * fails, the tokens stay in this process's memory and Enter retries without a new sign-in.
 * After login set CHATGPT_PLAN_ENABLED=1 in Vercel env and a weekly cap for the app in
 * ChatGPT → Settings → Usage. See docs/SETUP.md.
 */
import { createServer, type ServerResponse } from 'node:http';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { createClient } from '@supabase/supabase-js';
import { hasPlanScope } from '../src/lib/llm/chatgpt-connect';
import { argValue, envValue, resolveAppUrl } from './lib/login-config';

const AUTHORIZE = 'https://auth.openai.com/api/accounts/authorize';
const TOKEN = 'https://auth.openai.com/api/accounts/oauth/token';
const RESOURCE = 'https://api.openai.com/v1';
const SCOPE = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const PORT = 1455;
const STATE_FILE = 'scripts/.chatgpt-client.json'; // gitignored: issued client_id + host id
// Shown on the consent screen at first registration; the same name for every installation.
const AGENT_NAME = 'Рядом';
const HTTP_TIMEOUT_MS = 30_000;
const EXIT_DELAY_MS = 300;
const CONNECTED = '✓ ChatGPT plan connected. Now set CHATGPT_PLAN_ENABLED=1 in Vercel env.';
const b64u = (b: Buffer) => b.toString('base64url');

type OpenAiTokens = { access_token: string; refresh_token: string; expires_in: number; scope: string; earliest_refresh_at: string | number | null };
type Grant = { tokens: OpenAiTokens; clientId: string };

function fail(message: string): never {
  console.error(`✗ ${message}`);
  process.exit(1);
}

/** Reads a line from the terminal; `hidden` stops it from echoing (passwords). */
function ask(question: string, hidden = false): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) {
      const out = rl as unknown as { _writeToOutput: (s: string) => void; output: NodeJS.WriteStream };
      process.stdout.write(question);
      out._writeToOutput = (s: string) => { if (s.includes('\n')) out.output.write('\n'); };
    }
    rl.once('close', () => resolve('q')); // stdin closed: treat as "quit"
    rl.question(hidden ? '' : question, (answer) => { resolve(answer); rl.close(); });
  });
}

const email = envValue(argValue(process.argv, '--email'));
if (!email) fail('--email is required (your «Рядом» login)');
const supabaseUrl = envValue(process.env.NEXT_PUBLIC_SUPABASE_URL);
const publishableKey = envValue(process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY);
if (!supabaseUrl || !publishableKey) fail('NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY are required (vercel env pull)');
const appUrl = (() => {
  try {
    return resolveAppUrl(argValue(process.argv, '--app-url'), process.env.APP_URL);
  } catch (e) {
    return fail((e as Error).message);
  }
})();

// 1. Sign in to «Рядом» first, so a wrong password fails before the OpenAI consent.
const password = await ask(`Пароль от «Рядом» для ${email}: `, true);
const app = createClient(supabaseUrl, publishableKey, { auth: { persistSession: false, autoRefreshToken: false } });
const { data: signIn, error: signInError } = await app.auth.signInWithPassword({ email, password });
if (signInError || !signIn.session) fail(`Не удалось войти в «Рядом»: ${signInError?.message ?? 'нет сессии'}`);
let appRefreshToken = signIn.session.refresh_token;
console.log('✓ Вошёл в «Рядом».');

async function appFetch(path: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(`${appUrl}${path}`, { ...init, signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
  } catch (e) {
    throw new Error(`«Рядом» на ${appUrl} не отвечает: ${(e as Error).message}`);
  }
}

async function apiError(res: Response): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
  return body?.error?.message ?? `HTTP ${res.status}`;
}

/** Fresh «Рядом» access token: sessions last an hour and a retry may come much later. */
async function appAccessToken(): Promise<string> {
  const { data, error } = await app.auth.refreshSession({ refresh_token: appRefreshToken });
  if (error || !data.session) throw new Error(`сессия «Рядом» истекла (${error?.message ?? 'нет сессии'}), запусти скрипт заново`);
  appRefreshToken = data.session.refresh_token;
  return data.session.access_token;
}

/** Before the OpenAI consent: the app must accept this login and be able to store tokens. */
async function checkApp(token: string): Promise<void> {
  const res = await appFetch('/api/providers', { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 401) throw new Error(`«Рядом» на ${appUrl} не принял вход (${await apiError(res)}). Env-файл и --app-url от одного проекта?`);
  if (!res.ok) throw new Error(`«Рядом» на ${appUrl} ответил: ${await apiError(res)}`);
  const body = (await res.json().catch(() => null)) as { token_storage_ready?: boolean } | null;
  if (body?.token_storage_ready !== true) throw new Error(`«Рядом» на ${appUrl} пока не может сохранить токены: нет ключа шифрования или сервер старой версии`);
}

try {
  await checkApp(signIn.session.access_token);
} catch (e) {
  fail((e as Error).message);
}
console.log(`✓ «Рядом» на ${appUrl} готов принять подключение.`);

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

async function exchangeCode(u: URL): Promise<Grant> {
  if (u.searchParams.get('error')) throw new Error(`OpenAI: ${u.searchParams.get('error')}`);
  const code = u.searchParams.get('code');
  const clientId = u.searchParams.get('client_id') ?? saved.client_id;
  if (!code || !clientId) throw new Error('в ответе OpenAI нет code или выданного client_id');
  writeFileSync(STATE_FILE, JSON.stringify({ client_id: clientId, host_id: saved.host_id }, null, 2));
  const tr = await fetch(TOKEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', client_id: clientId, code, code_verifier: verifier, redirect_uri: redirectUri, resource: RESOURCE }),
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  const t = (await tr.json().catch(() => ({}))) as { access_token?: string; refresh_token?: string; expires_in?: number; scope?: string; earliest_refresh_at?: string | number; error?: string };
  if (!tr.ok || !t.access_token || !t.refresh_token) throw new Error(`OpenAI не выдал токены: ${t.error ?? tr.status}`);
  // A valid sign-in alone does not allow plan usage: the granted scopes must include it.
  if (!hasPlanScope(t.scope ?? '')) throw new Error('OpenAI не выдал право на план ChatGPT (доступ отклонён или недоступен для этого аккаунта)');
  return {
    clientId,
    tokens: { access_token: t.access_token, refresh_token: t.refresh_token, expires_in: t.expires_in ?? 3600, scope: t.scope ?? '', earliest_refresh_at: t.earliest_refresh_at ?? null },
  };
}

// 3. Hand the credentials to the backend, which encrypts and stores them.
async function deliver({ tokens, clientId }: Grant): Promise<void> {
  const res = await appFetch('/api/providers/chatgpt', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await appAccessToken()}` },
    body: JSON.stringify({ ...tokens, client_id: clientId }),
  });
  if (!res.ok) throw new Error(`«Рядом» не сохранил токены: ${await apiError(res)}`);
}

/** The tokens live only in this process, so a retry needs no new OpenAI sign-in. */
async function retryDelivery(grant: Grant): Promise<boolean> {
  for (;;) {
    const answer = await ask('Токены от OpenAI в памяти этого процесса. Enter: отправить в «Рядом» ещё раз, q: выйти. ');
    if (answer.trim().toLowerCase().startsWith('q')) return false;
    try {
      await deliver(grant);
      return true;
    } catch (e) {
      console.error('✗', (e as Error).message);
    }
  }
}

function reply(res: ServerResponse, status: number, text: string): void {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' }).end(text);
}

function finish(code: number): void {
  server.close();
  setTimeout(() => process.exit(code), EXIT_DELAY_MS);
}

let handled = false;
const server = createServer(async (req, res) => {
  const u = new URL(req.url ?? '/', redirectUri);
  if (u.pathname !== '/auth/callback') { res.writeHead(404).end(); return; }
  // A tab left from an earlier attempt carries another state: answer it and keep waiting.
  if (u.searchParams.get('state') !== state) { reply(res, 400, 'Это ссылка от прошлой попытки. Открой ссылку из терминала.'); return; }
  if (handled) { reply(res, 409, 'Этот вход уже обработан, смотри терминал.'); return; }
  handled = true;

  let grant: Grant;
  try {
    grant = await exchangeCode(u);
  } catch (e) {
    reply(res, 400, `Ошибка: ${(e as Error).message}`);
    console.error('✗', (e as Error).message);
    finish(1);
    return;
  }
  try {
    await deliver(grant);
    reply(res, 200, 'Готово: ChatGPT подключён к «Рядом». Окно можно закрыть.');
    console.log(CONNECTED);
    finish(0);
  } catch (e) {
    const message = (e as Error).message;
    reply(res, 502, `Вход в ChatGPT прошёл, но «Рядом» пока не принял токены: ${message}\nВернись в терминал: там можно повторить без нового входа.`);
    console.error('✗', message);
    const delivered = await retryDelivery(grant);
    if (delivered) console.log(CONNECTED);
    finish(delivered ? 0 : 1);
  }
});

server.on('error', (e) => fail(`Не получилось слушать 127.0.0.1:${PORT}: ${e.message}. Закрой прошлый запуск скрипта.`));
server.listen(PORT, '127.0.0.1', () => {
  console.log('Открой в браузере и подтверди доступ (ссылка действует для этой попытки):\n');
  console.log(url);
});
