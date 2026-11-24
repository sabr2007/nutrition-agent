import { rateLimit } from '@/lib/ratelimit';
import { handler, HttpError, json, readJson, requireUser } from '@/lib/http';
import { saveChatgptTokens } from '@/lib/llm/chatgpt';
import { ConnectBody, hasPlanScope, invalidFields } from '@/lib/llm/chatgpt-connect';

/**
 * Receives the ChatGPT plan credentials from the local sign-in CLI (the documented
 * "self-hosted VM" pattern: OAuth on the laptop, credentials moved to the backend).
 * The server encrypts them with its own key, so no secrets are needed on the laptop.
 */
export const POST = handler(async (req) => {
  const { userId } = await requireUser(req);
  rateLimit(`chatgpt-connect:${userId}`, 5, 10 * 60_000);
  const parsed = ConnectBody.safeParse(await readJson(req));
  if (!parsed.success) {
    throw new HttpError(400, `Неполные данные входа ChatGPT: ${invalidFields(parsed.error).join(', ')}`, 'validation');
  }
  if (!hasPlanScope(parsed.data.scope)) {
    throw new HttpError(403, 'OpenAI не выдала право использовать план ChatGPT', 'scope_missing');
  }
  await saveChatgptTokens(userId, parsed.data);
  return json({ ok: true });
});
