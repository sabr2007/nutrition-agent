import type { SupabaseClient } from '@supabase/supabase-js';
import { plural } from '@/lib/client/format';

// How much of the ChatGPT plan the week took (llm_calls keeps every call with its tokens): one
// line for the weekly review, so a limit that runs out is no surprise.

export type PlanUsage = { calls: number; failed: number; quotaHits: number; tokensIn: number; tokensOut: number };

const PAGE = 1000;
const MAX_PAGES = 10;
export const USAGE_DAYS = 7;

export function sumUsage(rows: { status: string; error_code: string | null; tokens_in: number | null; tokens_out: number | null }[]): PlanUsage {
  return rows.reduce<PlanUsage>((u, r) => ({
    calls: u.calls + 1,
    failed: u.failed + (r.status === 'error' ? 1 : 0),
    quotaHits: u.quotaHits + (r.status === 'error' && /^quota/.test(r.error_code ?? '') ? 1 : 0),
    tokensIn: u.tokensIn + (r.tokens_in ?? 0),
    tokensOut: u.tokensOut + (r.tokens_out ?? 0),
  }), { calls: 0, failed: 0, quotaHits: 0, tokensIn: 0, tokensOut: 0 });
}

export async function planUsage(sb: SupabaseClient, userId: string, since: Date): Promise<PlanUsage> {
  const rows: Parameters<typeof sumUsage>[0] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const { data, error } = await sb.from('llm_calls').select('status, error_code, tokens_in, tokens_out')
      .eq('user_id', userId).eq('provider', 'chatgpt').gte('created_at', since.toISOString())
      .order('created_at').range(page * PAGE, page * PAGE + PAGE - 1);
    if (error) throw new Error(`llm_calls: ${error.code}`);
    rows.push(...(data ?? []));
    if ((data ?? []).length < PAGE) break;
  }
  return sumUsage(rows);
}

const tokens = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1).replace('.', ',')} млн` : n >= 1e3 ? `${Math.round(n / 1e3)} тыс.` : String(n));

export function usageLine(u: PlanUsage): string {
  const limit = u.quotaHits ? `в лимит упёрлись ${u.quotaHits} раз` : 'в лимит не упирались';
  return `Расход плана ChatGPT за ${USAGE_DAYS} дней: ${u.calls} ${plural(u.calls, 'вызов', 'вызова', 'вызовов')}, ${tokens(u.tokensIn + u.tokensOut)} токенов (вход ${tokens(u.tokensIn)}, выход ${tokens(u.tokensOut)}); ${limit}.`;
}

export async function weeklyUsageLine(sb: SupabaseClient, userId: string, now = new Date()): Promise<string> {
  return usageLine(await planUsage(sb, userId, new Date(now.getTime() - USAGE_DAYS * 86_400_000)));
}
