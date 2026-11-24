import { handler, HttpError, json, readJson, requireUser } from '@/lib/http';
import { saveMeal, SaveMealSchema } from '@/lib/data/meals';

export const POST = handler(async (req) => {
  const { userId, sb } = await requireUser(req);
  const parsed = SaveMealSchema.safeParse(await readJson(req));
  if (!parsed.success) throw new HttpError(400, 'Проверь данные приёма', 'validation');
  const saved = await saveMeal(sb, userId, parsed.data);
  return json({ meal: saved });
});
