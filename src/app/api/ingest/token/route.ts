import { createHash, randomBytes } from 'node:crypto';
import { handler, json, requireUser } from '@/lib/http';
import { supabaseAdmin } from '@/lib/supabase/server';

// Issues a per-user ingest token for the Apple Shortcuts automation (steps/sleep import).
// Only its SHA-256 is stored; the token is shown once.
export const POST = handler(async (req) => {
  const { userId } = await requireUser(req);
  const token = `rh_${randomBytes(24).toString('base64url')}`;
  const hash = createHash('sha256').update(token).digest('hex');
  const admin = supabaseAdmin();
  const { data: p } = await admin.from('profiles').select('settings').eq('user_id', userId).single();
  await admin.from('profiles').update({ settings: { ...(p?.settings ?? {}), health_token_sha256: hash, health_token_created_at: new Date().toISOString() } }).eq('user_id', userId);
  return json({ token, endpoint: '/api/ingest/health' });
});
