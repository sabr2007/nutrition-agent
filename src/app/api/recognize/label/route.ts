import { z } from 'zod';
import { rateLimit } from '@/lib/ratelimit';
import { handler, HttpError, json, readJson, requireUser } from '@/lib/http';
import { LabelUnreadableError, readLabel } from '@/lib/recognition/label-read';

export const maxDuration = 120;

const Body = z.object({ media_id: z.string().uuid() });

/** Photo of a nutrition label → per-100 g values for the user to confirm. */
export const POST = handler(async (req) => {
  const { userId, sb } = await requireUser(req);
  rateLimit(`rec:${userId}`, 40, 5 * 60_000);
  const parsed = Body.safeParse(await readJson(req));
  if (!parsed.success) throw new HttpError(400, 'Нет фото этикетки', 'validation');
  const { data: media, error } = await sb.from('media').select('id, bucket, path, mime').eq('id', parsed.data.media_id).eq('user_id', userId).maybeSingle();
  if (error || !media) throw new HttpError(404, 'Фото не найдено', 'not_found');
  const { data: file, error: dErr } = await sb.storage.from(media.bucket as string).download(media.path as string);
  if (dErr || !file) throw new HttpError(404, 'Не удалось прочитать фото', 'storage');
  try {
    const result = await readLabel({
      sb, userId, mediaId: media.id as string,
      image: { data: new Uint8Array(await file.arrayBuffer()), mime: (media.mime as string) || 'image/jpeg' },
    });
    return json(result);
  } catch (e) {
    if (e instanceof LabelUnreadableError) throw new HttpError(422, e.message, 'label_unreadable');
    throw e;
  }
});
