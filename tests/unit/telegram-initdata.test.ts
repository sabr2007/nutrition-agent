import { describe, expect, test } from 'vitest';
import { dataCheckString, initDataHash, verifyInitData } from '@/lib/telegram/init-data';

const TOKEN = '123456:TEST-token-for-unit-tests';
const NOW = 1_795_000_000;

function sign(fields: Record<string, string>, token = TOKEN): string {
  const p = new URLSearchParams(fields);
  p.set('hash', initDataHash(p, token));
  return p.toString();
}
const user = JSON.stringify({ id: 1001, first_name: 'Owner', language_code: 'ru' });

describe('Mini App initData', () => {
  test('data-check string: every field but hash, sorted, key=value lines (signature stays)', () => {
    const p = new URLSearchParams({ user, auth_date: '1', query_id: 'Q', signature: 'S', hash: 'h' });
    expect(dataCheckString(p)).toBe(`auth_date=1\nquery_id=Q\nsignature=S\nuser=${user}`);
  });
  test('a correctly signed, fresh launch passes and names the Telegram user', () => {
    expect(verifyInitData(sign({ user, auth_date: String(NOW - 60), query_id: 'AAE', signature: 'sig' }), TOKEN, NOW)).toEqual({ ok: true, telegramUserId: 1001, authDate: NOW - 60 });
  });
  test('a changed field, another bot token or a forged hash fail', () => {
    const good = sign({ user, auth_date: String(NOW) });
    expect(verifyInitData(good.replace('1001', '1002'), TOKEN, NOW)).toEqual({ ok: false, reason: 'bad_hash' });
    expect(verifyInitData(good, '999:other', NOW)).toEqual({ ok: false, reason: 'bad_hash' });
    expect(verifyInitData(`user=${encodeURIComponent(user)}&auth_date=${NOW}&hash=${'0'.repeat(64)}`, TOKEN, NOW)).toEqual({ ok: false, reason: 'bad_hash' });
  });
  test('older than 24 hours (or from the future) is expired', () => {
    expect(verifyInitData(sign({ user, auth_date: String(NOW - 24 * 3600 - 1) }), TOKEN, NOW)).toEqual({ ok: false, reason: 'expired' });
    expect(verifyInitData(sign({ user, auth_date: String(NOW + 3600) }), TOKEN, NOW)).toEqual({ ok: false, reason: 'expired' });
  });
  test('no user or garbage', () => {
    expect(verifyInitData(sign({ auth_date: String(NOW) }), TOKEN, NOW)).toEqual({ ok: false, reason: 'no_user' });
    expect(verifyInitData('', TOKEN, NOW)).toEqual({ ok: false, reason: 'malformed' });
    expect(verifyInitData('a=b', TOKEN, NOW)).toEqual({ ok: false, reason: 'malformed' });
  });
});
