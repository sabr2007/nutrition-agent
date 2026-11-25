import { handleWebhook } from '@/lib/telegram/webhook';
import { telegramConfigured, telegramRuntime } from '@/lib/telegram/deps';

// Telegram → this webhook (secret header checked). The update is stored once and answered
// with 200 right away; the turn runs after the response — up to «Думать дольше» (240 s).
export const maxDuration = 300;

export async function POST(req: Request): Promise<Response> {
  if (!telegramConfigured()) return new Response('bot is not configured', { status: 503 });
  try {
    return await handleWebhook(req, telegramRuntime().webhook);
  } catch (e) {
    // Non-2xx makes Telegram retry later; the update_id makes the retry safe.
    console.error('[telegram] webhook failed', (e as Error).message?.slice(0, 200));
    return new Response('error', { status: 500 });
  }
}
