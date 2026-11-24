import { handler, HttpError, json, requireUser } from '@/lib/http';

export const DELETE = handler(async (req, ctx: { params: Promise<{ id: string }> }) => {
  const { sb } = await requireUser(req);
  const { id } = await ctx.params;
  const { data, error } = await sb.rpc('delete_meal', { p_id: id });
  if (error) throw new HttpError(404, 'Приём не найден', 'not_found');
  return json({ meal: { id: (data as { id: string }).id, status: 'deleted' } });
});
