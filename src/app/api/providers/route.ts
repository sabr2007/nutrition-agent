import { handler, json, requireUser } from '@/lib/http';
import { encryptionReady } from '@/lib/llm/crypto';
import { MODELS } from '@/lib/llm/models';
import { supabaseAdmin } from '@/lib/supabase/server';

const WEEK_MS = 7 * 86_400_000;

type Usage = { calls: number; errors: number; cost: number };

export const GET = handler(async (req) => {
  const { userId, sb } = await requireUser(req);
  const { data: conn } = await supabaseAdmin().from('provider_connections').select('status, expires_at, updated_at')
    .eq('user_id', userId).eq('provider', 'chatgpt').maybeSingle();
  const since = new Date(Date.now() - WEEK_MS).toISOString();
  const { data: calls } = await sb.from('llm_calls').select('model, status, cost_usd').eq('user_id', userId).gte('created_at', since);
  const usage: Record<string, Usage> = {};
  for (const c of calls ?? []) {
    const k = c.model as string;
    const prev = usage[k] ?? { calls: 0, errors: 0, cost: 0 };
    usage[k] = { calls: prev.calls + 1, errors: prev.errors + (c.status === 'error' ? 1 : 0), cost: prev.cost + Number(c.cost_usd ?? 0) };
  }
  return json({
    chatgpt: { status: conn?.status ?? 'not_connected', updated_at: conn?.updated_at ?? null },
    models: Object.fromEntries(Object.entries(MODELS).map(([task, spec]) => [task, spec.model])),
    // Checked by scripts/chatgpt-login.ts before the OpenAI consent, so a bad key fails early.
    token_storage_ready: encryptionReady(),
    usage_7d: usage,
  });
});
