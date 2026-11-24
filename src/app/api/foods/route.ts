import { handler, HttpError, json, readJson, requireUser } from '@/lib/http';
import { createPersonalFood, PersonalFoodSchema } from '@/lib/data/foods';

/** Creates a personal food from a label (photo-read or typed); reuses an identical one. */
export const POST = handler(async (req) => {
  const { userId, sb } = await requireUser(req);
  const parsed = PersonalFoodSchema.safeParse(await readJson(req));
  if (!parsed.success) throw new HttpError(400, parsed.error.issues[0]?.message ?? 'Проверь цифры', 'validation');
  try {
    const result = await createPersonalFood(sb, userId, parsed.data, parsed.data.recognition_id ? 'photo' : 'manual');
    return json(result);
  } catch (e) {
    throw new HttpError(500, (e as Error).message, 'db');
  }
});
