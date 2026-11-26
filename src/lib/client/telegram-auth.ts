'use client';

import { writeSession, type LiteSession } from './session';

// Mini App sign-in with Telegram's launch data (D30, D32). One request at a time: two at once
// made the server mint two magic links for one account, and the first one died (otp_expired).
// A network or server error is retried once before the screen shows it.

export type TgSignIn = { ok: true; session: LiteSession } | { ok: false; message: string };

const RETRY_DELAY_MS = 600;
const FALLBACK = 'Не удалось войти через Telegram';

let inflight: Promise<TgSignIn> | null = null;

export function signInWithTelegram(initData: string): Promise<TgSignIn> {
  inflight ??= attempt(initData).finally(() => { inflight = null; });
  return inflight;
}

async function attempt(initData: string): Promise<TgSignIn> {
  let last: TgSignIn = { ok: false, message: FALLBACK };
  for (let i = 0; i < 2; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
    const res = await fetch('/api/telegram/auth', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ initData }) }).catch(() => null);
    const body = (await res?.json().catch(() => null)) as (LiteSession & { error?: undefined }) | { error: { message?: string } } | null;
    if (res?.ok && body && !body.error) {
      const session = body as LiteSession;
      writeSession(session);
      return { ok: true, session };
    }
    last = { ok: false, message: body?.error?.message || FALLBACK };
    const retryable = !res || res.status >= 500;
    if (!retryable) break;
  }
  return last;
}
