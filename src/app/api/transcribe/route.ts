import { z } from 'zod';
import { rateLimit } from '@/lib/ratelimit';
import { handler, HttpError, json, readJson, requireUser } from '@/lib/http';
import { LlmError } from '@/lib/llm/router';
import { transcribeAudio } from '@/lib/llm/transcribe';

export const maxDuration = 60;

const Body = z.object({ media_id: z.string().uuid() });

/** Chat microphone: a stored voice note → text for the composer. */
export const POST = handler(async (req) => {
  const { userId, sb } = await requireUser(req);
  rateLimit(`stt:${userId}`, 40, 5 * 60_000);
  const parsed = Body.safeParse(await readJson(req));
  if (!parsed.success) throw new HttpError(400, 'Нет записи', 'validation');
  const { data: m, error } = await sb.from('media').select('id, bucket, path').eq('id', parsed.data.media_id).eq('user_id', userId).eq('kind', 'audio').maybeSingle();
  if (error || !m) throw new HttpError(404, 'Запись не найдена', 'not_found');
  const { data: blob, error: dErr } = await sb.storage.from(m.bucket as string).download(m.path as string);
  if (dErr || !blob) throw new HttpError(404, 'Не удалось прочитать запись', 'storage');
  try {
    const tr = await transcribeAudio(new Uint8Array(await blob.arrayBuffer()), { userId, purpose: 'transcribe_chat' });
    return json({ text: tr.text });
  } catch (e) {
    if (e instanceof LlmError) throw new HttpError(503, e.message, 'stt_unavailable');
    throw e;
  }
});
