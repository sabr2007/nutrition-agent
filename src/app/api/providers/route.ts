import { handler, json, requireUser } from '@/lib/http';
import { providerStatus } from '@/lib/llm/router';
import { supabaseAdmin } from '@/lib/supabase/server';
import { serverEnv } from '@/lib/env';

export const GET = handler(async (req) => {
  const { userId, sb } = await requireUser(req);
  const env = serverEnv();
  const { data: conn } = await supabaseAdmin().from('provider_connections').select('provider, status, expires_at, scope, updated_at').eq('user_id', userId);
  const since = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const { data: calls } = await sb.from('llm_calls').select('provider, model, status, cost_usd, tokens_in, tokens_out').eq('user_id', userId).gte('created_at', since);
  const usage: Record<string, { calls: number; errors: number; cost: number }> = {};
  for (const c of calls ?? []) {
    const k = `${c.provider}/${c.model}`;
    usage[k] ??= { calls: 0, errors: 0, cost: 0 };
    usage[k].calls++;
    if (c.status === 'error') usage[k].errors++;
    usage[k].cost += Number(c.cost_usd ?? 0);
  }
  return json({
    order: env.providerOrder,
    configured: { gateway: env.gatewayConfigured, openai: Boolean(env.openaiApiKey), workers_ai: Boolean(env.cloudflareApiToken), chatgpt_plan: process.env.CHATGPT_PLAN_ENABLED === '1' },
    routes: providerStatus(),
    connections: conn ?? [],
    usage_7d: usage,
  });
});
