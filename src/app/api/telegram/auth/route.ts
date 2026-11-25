import { z } from 'zod';
import { mintOwnerSession } from '@/lib/auth/owner-session';
import { serverEnv } from '@/lib/env';
import { handler, HttpError, json } from '@/lib/http';
import { rateLimit } from '@/lib/ratelimit';
import { supabaseAdmin } from '@/lib/supabase/server';
import { verifyInitData } from '@/lib/telegram/init-data';

// Mini App sign-in: Telegram's signed launch data → the owner's ordinary Supabase session, so the
// whole API (Bearer JWT + RLS) works unchanged. Only the linked Telegram account gets in; the
// service role never leaves the server.

const Body = z.object({ initData: z.string().min(1).max(4096) });
const PER_MINUTE = 20;

export const POST = handler(async (req) => {
  rateLimit(`tg-auth:${req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'anon'}`, PER_MINUTE, 60_000);
  const parsed = Body.safeParse(await req.json().catch(() => undefined));
  if (!parsed.success) throw new HttpError(400, 'Нет данных запуска Telegram', 'bad_request');
  const token = serverEnv().telegramBotToken;
  if (!token) throw new HttpError(503, 'Бот не настроен', 'not_configured');
  const check = verifyInitData(parsed.data.initData, token);
  if (!check.ok) throw new HttpError(401, 'Данные запуска не прошли проверку — открой приложение из бота заново', check.reason);
  const { data: owner } = await supabaseAdmin().from('profiles').select('user_id').eq('telegram_user_id', check.telegramUserId).maybeSingle();
  if (!owner) throw new HttpError(403, 'Этот Telegram не привязан. Напиши боту /start <код>', 'not_linked');
  const s = await mintOwnerSession(owner.user_id as string);
  return json({ access_token: s.access_token, refresh_token: s.refresh_token, expires_at: s.expires_at }, { headers: { 'Cache-Control': 'no-store' } });
});
