import { handler, json, requireUser } from '@/lib/http';
import { getProfile } from '@/lib/data/profile';
import { getTrends } from '@/lib/agent/trends';

export const GET = handler(async (req) => {
  const { userId, sb } = await requireUser(req);
  const days = Math.min(60, Math.max(3, Number(new URL(req.url).searchParams.get('days') ?? 7)));
  const profile = await getProfile(sb, userId);
  return json(await getTrends(sb, userId, profile, days));
});
