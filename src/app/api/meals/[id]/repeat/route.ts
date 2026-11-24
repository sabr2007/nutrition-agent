import { handler, json, readJson, requireUser } from '@/lib/http';
import { repeatMeal } from '@/lib/data/meals';

export const POST = handler(async (req, ctx: { params: Promise<{ id: string }> }) => {
  const { userId, sb } = await requireUser(req);
  const { id } = await ctx.params;
  const body = await readJson<{ eaten_at?: string }>(req).catch(() => ({} as { eaten_at?: string }));
  const meal = await repeatMeal(sb, userId, id, body.eaten_at);
  return json({ meal });
});
