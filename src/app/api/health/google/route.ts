import { handler, json, requireUser } from '@/lib/http';
import { disconnect, googleConfigured, PROVIDER } from '@/lib/health/google';
import { supabaseAdmin } from '@/lib/supabase/server';

// Status for the Mini App settings and disconnect. Tokens never leave the server.
export const GET = handler(async (req) => {
  const { userId } = await requireUser(req);
  const { data } = await supabaseAdmin().from('provider_connections').select('status, scope, meta, updated_at').eq('user_id', userId).eq('provider', PROVIDER).maybeSingle();
  const meta = (data?.meta ?? {}) as Record<string, unknown>;
  return json({
    configured: googleConfigured(),
    status: data?.status ?? 'none',
    last_sync_at: meta.last_sync_at ?? null,
    last_error: meta.last_error ?? null,
    refresh_expires_at: meta.refresh_expires_at ?? null,
    scopes: (data?.scope as string | null)?.split(' ').filter(Boolean) ?? [],
  });
});

export const DELETE = handler(async (req) => {
  const { userId } = await requireUser(req);
  await disconnect(userId);
  return json({ ok: true });
});
