import { z } from 'zod';
import { handler, HttpError, json, readJson, requireUser } from '@/lib/http';
import { logTemplate } from '@/lib/data/meals';

const Body = z.object({
  template_id: z.string().uuid(),
  eaten_at: z.string().datetime({ offset: true }).optional(),
  client_id: z.string().max(80).nullable().optional(),
  scale: z.number().min(0.1).max(5).optional(),
});

export const POST = handler(async (req) => {
  const { userId, sb } = await requireUser(req);
  const parsed = Body.safeParse(await readJson(req));
  if (!parsed.success) throw new HttpError(400, 'Некорректный шаблон', 'validation');
  const meal = await logTemplate(sb, userId, { templateId: parsed.data.template_id, eatenAt: parsed.data.eaten_at, clientId: parsed.data.client_id, scale: parsed.data.scale });
  return json({ meal });
});
