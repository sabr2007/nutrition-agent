import { z } from 'zod';
import { rateLimit } from '@/lib/ratelimit';
import { handler, HttpError, json, readJson, requireUser } from '@/lib/http';
import { parseFoodText } from '@/lib/recognition/pipeline';

export const maxDuration = 60;

const Body = z.object({ text: z.string().min(1).max(1500), local_time: z.string().max(5).optional() });

export const POST = handler(async (req) => {
  const { userId, sb } = await requireUser(req);
  rateLimit(`rec:${userId}`, 40, 5 * 60_000);
  const parsed = Body.safeParse(await readJson(req));
  if (!parsed.success) throw new HttpError(400, 'Напиши, что съел', 'validation');
  const result = await parseFoodText({ sb, userId, text: parsed.data.text, kind: 'text', hints: { localTime: parsed.data.local_time } });
  return json(result);
});
