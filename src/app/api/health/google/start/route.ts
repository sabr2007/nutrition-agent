import { handler, HttpError, json, requireUser } from '@/lib/http';
import { authUrl, googleConfigured } from '@/lib/health/google';

// The Mini App asks for the Google consent URL and opens it in the external browser
// (Telegram.WebApp.openLink): Google blocks OAuth inside embedded webviews.
export const POST = handler(async (req) => {
  const { userId } = await requireUser(req);
  if (!googleConfigured()) throw new HttpError(503, 'Google Health ещё не настроен (нет OAuth-клиента)', 'not_configured');
  return json({ url: authUrl(userId) });
});
