import { z } from 'zod';
import { rateLimit } from '@/lib/ratelimit';
import { handler, HttpError, json, readJson, requireUser } from '@/lib/http';
import { transcribeAudio } from '@/lib/llm/transcribe';
import { parseFoodText } from '@/lib/recognition/pipeline';

export const maxDuration = 90;

const Body = z.object({ media_id: z.string().uuid(), local_time: z.string().max(5).optional() });

export const POST = handler(async (req) => {
  const { userId, sb } = await requireUser(req);
  rateLimit(`rec:${userId}`, 40, 5 * 60_000);
  const parsed = Body.safeParse(await readJson(req));
  if (!parsed.success) throw new HttpError(400, 'Нет записи', 'validation');
  const { data: m, error } = await sb.from('media').select('id, bucket, path, mime').eq('id', parsed.data.media_id).eq('user_id', userId).single();
  if (error || !m) throw new HttpError(404, 'Запись не найдена', 'not_found');
  const { data: blob, error: dErr } = await sb.storage.from(m.bucket as string).download(m.path as string);
  if (dErr || !blob) throw new HttpError(404, 'Не удалось прочитать запись', 'storage');
  const audio = new Uint8Array(await blob.arrayBuffer());
  const tr = await transcribeAudio(audio, { userId, purpose: 'transcribe' });
  if (!tr.text.trim()) throw new HttpError(422, 'Не расслышал. Попробуй ещё раз или напиши текстом.', 'empty_transcript');
  const result = await parseFoodText({ sb, userId, text: tr.text, kind: 'voice', mediaIds: [m.id as string], transcript: tr.text, hints: { localTime: parsed.data.local_time } });
  return json({ ...result, transcript: tr.text });
});
