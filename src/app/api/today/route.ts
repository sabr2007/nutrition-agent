import { handler, json, requireUser } from '@/lib/http';
import { getDaySummary } from '@/lib/data/day';
import { listTemplates } from '@/lib/data/meals';
import { findProfile } from '@/lib/data/profile';

export const GET = handler(async (req) => {
  const t0 = performance.now();
  const { userId, sb } = await requireUser(req);
  const t1 = performance.now();
  const day = new URL(req.url).searchParams.get('day') ?? undefined;
  if (day && !/^\d{4}-\d{2}-\d{2}$/.test(day)) return json({ error: { message: 'bad day', code: 'bad_request' } }, 400);
  // Two round trips to the database after the token check: the profile, then the day and the templates together.
  const profile = await findProfile(sb, userId);
  if (!profile) return json({ error: { message: 'Профиль не найден — войди заново', code: 'no_profile' } }, 401);
  const t2 = performance.now();
  const [summary, templates] = await Promise.all([getDaySummary(sb, userId, day, profile), listTemplates(sb, userId)]);
  const t3 = performance.now();
  const timing = `auth;dur=${(t1 - t0).toFixed(1)}, profile;dur=${(t2 - t1).toFixed(1)}, day;dur=${(t3 - t2).toFixed(1)}`;
  return json({
    summary,
    templates: templates.map(({ items, ...t }) => ({ ...t, items: items.map((i) => ({ food_id: i.food_id, grams: Number(i.grams), name: i.foods.name_ru, note: i.note })) })),
    // The Mini App has no coach card any more (D30); kept in the shape for older clients.
    coach: null,
    notification: null,
  }, { headers: { 'Server-Timing': timing } });
});
