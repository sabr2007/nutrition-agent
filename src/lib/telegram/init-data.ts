import { createHmac, timingSafeEqual } from 'node:crypto';

// Mini App launch data (Telegram.WebApp.initData), checked on the server (docs/research/telegram-bot-api.md):
//   secret = HMAC_SHA256(key = "WebAppData", msg = bot_token)
//   hash   = hex(HMAC_SHA256(key = secret, msg = data_check_string))
// where data_check_string is every field except `hash`, sorted by key, as `key=value` lines.
// `signature` (third-party Ed25519 check) stays in the string.

export const INIT_DATA_MAX_AGE_S = 24 * 3600;

export type InitDataResult =
  | { ok: true; telegramUserId: number; authDate: number }
  | { ok: false; reason: 'malformed' | 'bad_hash' | 'expired' | 'no_user' };

export function dataCheckString(params: URLSearchParams): string {
  return [...params.entries()].filter(([k]) => k !== 'hash').sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => `${k}=${v}`).join('\n');
}

export function initDataHash(params: URLSearchParams, botToken: string): string {
  const secret = createHmac('sha256', 'WebAppData').update(botToken).digest();
  return createHmac('sha256', secret).update(dataCheckString(params)).digest('hex');
}

export function verifyInitData(initData: string, botToken: string, nowS = Math.floor(Date.now() / 1000)): InitDataResult {
  if (!initData || initData.length > 4096 || !botToken) return { ok: false, reason: 'malformed' };
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash || !/^[0-9a-f]{64}$/.test(hash)) return { ok: false, reason: 'malformed' };
  const want = Buffer.from(initDataHash(params, botToken), 'hex');
  const got = Buffer.from(hash, 'hex');
  if (got.length !== want.length || !timingSafeEqual(got, want)) return { ok: false, reason: 'bad_hash' };
  const authDate = Number(params.get('auth_date'));
  if (!Number.isFinite(authDate) || authDate <= 0 || nowS - authDate > INIT_DATA_MAX_AGE_S || authDate - nowS > 300) return { ok: false, reason: 'expired' };
  try {
    const user = JSON.parse(params.get('user') ?? 'null') as { id?: number } | null;
    if (!user || typeof user.id !== 'number') return { ok: false, reason: 'no_user' };
    return { ok: true, telegramUserId: user.id, authDate };
  } catch {
    return { ok: false, reason: 'malformed' };
  }
}
