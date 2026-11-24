import { z } from 'zod';
import { rateLimit } from '@/lib/ratelimit';
import { handler, HttpError, json, readJson, requireUser } from '@/lib/http';
import { saveChatgptTokens } from '@/lib/llm/chatgpt';

const PLAN_SCOPE = 'chatgpt.tokens.use.direct';

const Body = z.object({
  access_token: z.string().min(20).max(20_000),
  refresh_token: z.string().min(20).max(20_000),
  expires_in: z.number().int().positive().max(86_400),
  scope: z.string().max(1000),
  client_id: z.string().regex(/^oaiapp_[A-Za-z0-9_-]+$/),
  earliest_refresh_at: z.string().max(64).nullish(),
});

/**
 * Receives the ChatGPT plan credentials from the local sign-in CLI (the documented
 * "self-hosted VM" pattern: OAuth on the laptop, credentials moved to the backend).
 * The server encrypts them with its own key, so no secrets are needed on the laptop.
 */
export const POST = handler(async (req) => {
  const { userId } = await requireUser(req);
  rateLimit(`chatgpt-connect:${userId}`, 5, 10 * 60_000);
  const parsed = Body.safeParse(await readJson(req));
  if (!parsed.success) throw new HttpError(400, 'Неполные данные входа ChatGPT', 'validation');
  if (!parsed.data.scope.split(' ').includes(PLAN_SCOPE)) {
    throw new HttpError(403, 'OpenAI не выдала право использовать план ChatGPT', 'scope_missing');
  }
  await saveChatgptTokens(userId, parsed.data);
  return json({ ok: true });
});
