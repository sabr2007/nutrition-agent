import { connectWithCode, verifyState } from '@/lib/health/google';
import { syncGoogleHealth } from '@/lib/health/sync';
import { getProfile } from '@/lib/data/profile';
import { supabaseAdmin } from '@/lib/supabase/server';

// Google redirects here after consent (in the external browser, no app session): the signed
// state names the user. A small page tells what happened and sends them back to Telegram.
export const maxDuration = 60;

const MESSAGES: Record<string, string> = {
  ok: 'Google Health подключён. Можно вернуться в Telegram — данные о шагах, сне и тренировках появятся через пару минут.',
  denied: 'Доступ не выдан. Если передумаешь — снова нажми «Подключить» в настройках.',
  state: 'Ссылка устарела или испорчена. Нажми «Подключить» в настройках ещё раз.',
  not_linked: 'Google-аккаунт ещё не связан с приложением Google Health. Открой Google Health на телефоне, войди этим аккаунтом, затем подключи снова.',
  legacy_fitbit: 'Вошёл старый Fitbit-аккаунт. В приложении Google Health войди через Google (или перенеси Fitbit-аккаунт), затем подключи снова.',
  scope: 'Не выданы разрешения на шаги, пульс и сон. Подключи снова и отметь все пункты.',
  token: 'Google не выдал токены. Попробуй ещё раз через минуту.',
};

function page(key: string, ok: boolean): Response {
  const text = MESSAGES[key] ?? MESSAGES.token;
  const html = `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Рядом · Google Health</title>
<style>body{font:17px/1.5 -apple-system,system-ui,sans-serif;background:#efede4;color:#1d1b16;margin:0;display:grid;place-items:center;min-height:100vh}main{max-width:420px;padding:28px}h1{font-size:22px;margin:0 0 12px}a{color:#1d1b16}</style></head>
<body><main><h1>${ok ? '✓ Готово' : 'Не получилось'}</h1><p>${text}</p><p><a href="tg://resolve">Вернуться в Telegram</a></p></main></body></html>`;
  return new Response(html, { status: ok ? 200 : 400, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
}

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  if (url.searchParams.get('error')) return page('denied', false);
  const userId = verifyState(url.searchParams.get('state') ?? '');
  const code = url.searchParams.get('code');
  if (!userId || !code) return page('state', false);
  try {
    const r = await connectWithCode(userId, code);
    if (!r.ok) return page(r.reason, false);
    const admin = supabaseAdmin();
    await syncGoogleHealth(admin, userId, await getProfile(admin, userId)).catch(() => null);
    return page('ok', true);
  } catch (e) {
    console.error('[health] callback failed', (e as Error).message?.slice(0, 160));
    return page('token', false);
  }
}
