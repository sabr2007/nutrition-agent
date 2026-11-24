import { z } from 'zod';
import { rateLimit } from '@/lib/ratelimit';
import { handler, HttpError, json, readJson, requireUser } from '@/lib/http';
import { recognizePhoto } from '@/lib/recognition/pipeline';

export const maxDuration = 200;

const Body = z.object({
  media_ids: z.array(z.string().uuid()).min(1).max(3),
  mode: z.enum(['plate', 'scale', 'label']).optional(),
  note: z.string().max(300).optional(),
  local_time: z.string().max(5).optional(),
});

export const POST = handler(async (req) => {
  const { userId, sb } = await requireUser(req);
  rateLimit(`rec:${userId}`, 40, 5 * 60_000);
  const parsed = Body.safeParse(await readJson(req));
  if (!parsed.success) throw new HttpError(400, 'Нет фото', 'validation');
  const { data: media, error } = await sb.from('media').select('id, bucket, path, mime').in('id', parsed.data.media_ids).eq('user_id', userId);
  if (error || !media?.length) throw new HttpError(404, 'Фото не найдено', 'not_found');
  const images = await Promise.all(media.map(async (m) => {
    const { data, error: dErr } = await sb.storage.from(m.bucket as string).download(m.path as string);
    if (dErr || !data) throw new HttpError(404, 'Не удалось прочитать фото', 'storage');
    return { data: new Uint8Array(await data.arrayBuffer()), mime: (m.mime as string) || 'image/jpeg' };
  }));
  const result = await recognizePhoto({
    sb, userId, images, mediaIds: media.map((m) => m.id as string),
    hints: { mode: parsed.data.mode ?? 'plate', note: parsed.data.note, localTime: parsed.data.local_time },
  });
  return json(result);
});
