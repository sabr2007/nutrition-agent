import 'server-only';
import * as webpush from 'web-push';
import type { SupabaseClient } from '@supabase/supabase-js';
import { publicEnv, serverEnv } from '@/lib/env';

let configured = false;
function configure(): boolean {
  if (configured) return true;
  const env = serverEnv();
  if (!publicEnv.vapidPublicKey || !env.vapidPrivateKey) return false;
  webpush.setVapidDetails(env.vapidSubject, publicEnv.vapidPublicKey, env.vapidPrivateKey);
  configured = true;
  return true;
}

export type PushPayload = { title: string; body: string; url?: string; notificationId?: string; tag?: string };

/** Sends to all active subscriptions of the user. Returns number of successful deliveries. */
export async function sendPush(admin: SupabaseClient, userId: string, payload: PushPayload): Promise<{ delivered: number; failed: number; configured: boolean; subscriptions: number }> {
  if (!configure()) return { delivered: 0, failed: 0, configured: false, subscriptions: 0 };
  const { data: subs } = await admin.from('push_subscriptions').select('id, endpoint, p256dh, auth, failure_count').eq('user_id', userId).is('disabled_at', null);
  let delivered = 0;
  let failed = 0;
  // Declarative Web Push (Safari 18.4+ / iOS): displayed by the OS even without a running
  // service worker, so it can never count as a "silent" push. Other browsers hand the same
  // JSON to our SW push handler, which understands this shape. Keep it under 4 KB.
  const url = new URL(payload.url ?? '/', serverEnv().appUrl);
  if (payload.notificationId) url.searchParams.set('n', payload.notificationId);
  const body = JSON.stringify({
    web_push: 8030,
    notification: {
      title: payload.title,
      body: payload.body,
      navigate: url.toString(),
      lang: 'ru',
      dir: 'ltr',
      tag: payload.tag ?? payload.notificationId ?? undefined,
      silent: false,
      data: { id: payload.notificationId ?? null, url: url.pathname + url.search },
    },
  });
  await Promise.all((subs ?? []).map(async (s) => {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint as string, keys: { p256dh: s.p256dh as string, auth: s.auth as string } }, body, { TTL: 60 * 60, urgency: 'high', topic: (payload.tag ?? 'ryadom').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32) || 'ryadom' });
      delivered++;
      await admin.from('push_subscriptions').update({ last_success_at: new Date().toISOString(), failure_count: 0 }).eq('id', s.id);
    } catch (err) {
      failed++;
      const status = (err as { statusCode?: number }).statusCode;
      const gone = status === 404 || status === 410;
      await admin.from('push_subscriptions').update({
        failure_count: Number(s.failure_count) + 1,
        disabled_at: gone || Number(s.failure_count) >= 5 ? new Date().toISOString() : null,
      }).eq('id', s.id);
    }
  }));
  return { delivered, failed, configured: true, subscriptions: (subs ?? []).length };
}
