import { handler, json, requireUser } from '@/lib/http';
import { rateLimit } from '@/lib/ratelimit';
import { getProfile } from '@/lib/data/profile';
import { syncGoogleHealth } from '@/lib/health/sync';
import { supabaseAdmin } from '@/lib/supabase/server';

export const maxDuration = 60;

/** «Обновить сейчас» in the Mini App settings. */
export const POST = handler(async (req) => {
  const { userId } = await requireUser(req);
  rateLimit(`health-sync:${userId}`, 6, 10 * 60_000);
  const admin = supabaseAdmin();
  return json(await syncGoogleHealth(admin, userId, await getProfile(admin, userId)));
});
