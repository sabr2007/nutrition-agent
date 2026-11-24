import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getProfile, type Profile } from '@/lib/data/profile';
import { localParts, addDays } from '@/lib/nutrition/day';
import { genText } from '@/lib/llm/generate';
import { runAgent } from '@/lib/agent/run';
import { sendPush } from '@/lib/push/send';
import { evaluate, fillTemplate, inQuietHours, minutesSince, type Condition, type Facts } from './dsl';
import { computeFacts } from './facts';

type Rule = {
  id: string; key: string; title: string; kind: 'schedule' | 'context' | 'agent'; enabled: boolean;
  at_time: string | null; window_minutes: number; days: number[] | null; training_days_only: boolean;
  condition: Condition; template: string; compose_with_llm: boolean; skill_key: string | null;
  priority: number; cooldown_minutes: number; once_per_day: boolean; deep_link: string;
};

export type TickReport = { userId: string; considered: number; sent: string[]; skipped: Record<string, string>; delivered: number; errors: string[] };

// Agent-initiated messages (not the reminders the user asked for) are rate-limited:
// quiet hours, a daily cap, a minimum gap, and silence after 2 unanswered nudges.
const AGENT_DAILY_CAP = 3;
const AGENT_MIN_GAP_MIN = 120;

export async function runTick(admin: SupabaseClient, now = new Date()): Promise<TickReport[]> {
  const { data: users } = await admin.from('profiles').select('user_id');
  const reports: TickReport[] = [];
  for (const u of users ?? []) {
    try {
      reports.push(await tickUser(admin, u.user_id as string, now));
    } catch (e) {
      reports.push({ userId: u.user_id as string, considered: 0, sent: [], skipped: {}, delivered: 0, errors: [(e as Error).message.slice(0, 200)] });
    }
  }
  return reports;
}

async function deliver(admin: SupabaseClient, userId: string, n: { id: string; title: string; body: string; deep_link: string | null; rule_key: string | null }) {
  const r = await sendPush(admin, userId, { title: n.title, body: n.body, url: n.deep_link ?? '/', notificationId: n.id, tag: n.rule_key ?? undefined });
  await admin.from('notifications').update({
    // No subscription (or push not configured) → still "sent": it shows in-app on Today/Coach.
    status: r.delivered > 0 || !r.configured || r.subscriptions === 0 ? 'sent' : 'failed', sent_at: new Date().toISOString(), delivered_count: r.delivered,
  }).eq('id', n.id);
  return r.delivered;
}

async function tickUser(admin: SupabaseClient, userId: string, now: Date): Promise<TickReport> {
  const report: TickReport = { userId, considered: 0, sent: [], skipped: {}, delivered: 0, errors: [] };
  const profile = await getProfile(admin, userId);
  const local = localParts(now, profile.timezone);
  const quiet = inQuietHours(local.hhmm, profile.quiet_start, profile.quiet_end);

  // 1) Due one-off notifications (snoozes, agent-scheduled reminders).
  const { data: due } = await admin.from('notifications').select('id, title, body, deep_link, rule_key').eq('user_id', userId).eq('status', 'pending').lte('scheduled_for', now.toISOString()).limit(5);
  for (const n of due ?? []) {
    if (quiet) continue;
    report.delivered += await deliver(admin, userId, n as { id: string; title: string; body: string; deep_link: string | null; rule_key: string | null });
    report.sent.push(`pending:${n.rule_key ?? n.id}`);
  }

  // 2) Day rollover: deterministic episodic summary of yesterday (no LLM needed).
  await summarizeYesterday(admin, userId, profile, now).catch((e) => report.errors.push(`summary: ${(e as Error).message.slice(0, 120)}`));

  if (quiet) {
    report.skipped['*'] = 'quiet_hours';
    return report;
  }

  // 3) Rules — cheap SQL/logic gate first; the LLM is only called for rules that fire.
  const { data: rules } = await admin.from('reminder_rules').select('*').eq('user_id', userId).eq('enabled', true).order('sort_order');
  if (!rules?.length) return report;
  const { facts, summary } = await computeFacts(admin, userId, profile, now);
  const { data: todays } = await admin.from('notifications').select('rule_key, status, sent_at, created_at, reaction, opened_at').eq('user_id', userId).eq('local_day', summary.day);

  for (const rule of rules as Rule[]) {
    report.considered++;
    const skip = (why: string) => { report.skipped[rule.key] = why; };
    if (rule.days?.length && !rule.days.includes(local.isoWeekday)) { skip('weekday'); continue; }
    if (rule.training_days_only && !summary.trainingDay) { skip('not_training_day'); continue; }
    if (rule.at_time) {
      const since = minutesSince(local.hhmm, rule.at_time.slice(0, 5));
      if (since > rule.window_minutes) { skip('outside_window'); continue; }
    }
    const already = (todays ?? []).filter((n) => n.rule_key === rule.key && n.status !== 'suppressed');
    if (rule.once_per_day && already.length) { skip('already_today'); continue; }
    const last = already.map((n) => Date.parse((n.sent_at ?? n.created_at) as string)).sort((a, b) => b - a)[0];
    if (last && now.getTime() - last < rule.cooldown_minutes * 60_000) { skip('cooldown'); continue; }
    if (!evaluate(rule.condition, facts)) { skip('condition_false'); continue; }

    let body: string | null = null;
    if (rule.kind === 'agent') {
      const gate = await agentGate(admin, userId, profile, now);
      if (gate) { skip(gate); continue; }
      const sentToday = (todays ?? []).filter((n) => n.status === 'sent').length;
      const r = await runAgent({ sb: admin, userId, trigger: 'cron', skillKey: rule.skill_key ?? 'proactive_checkin', proactive: { reason: rule.title, ruleKey: rule.key, template: rule.template, sentToday, lastSentAt: null }, now });
      if (r.decision !== 'sent') { skip(`agent_${r.decision}`); await recordSuppressed(admin, userId, summary.day, rule, `agent:${r.decision}`); continue; }
      body = r.text;
    } else if (rule.compose_with_llm) {
      body = await compose(userId, rule, facts).catch(() => null);
    }
    body = (body ?? fillTemplate(rule.template, facts)).slice(0, 300);

    const { data: n, error } = await admin.from('notifications').insert({
      user_id: userId, rule_key: rule.key, local_day: summary.day, title: rule.kind === 'agent' ? 'Рядом' : rule.title,
      body, deep_link: rule.deep_link, status: 'pending', payload: { facts: pickFacts(facts) },
    }).select('id, title, body, deep_link, rule_key').single();
    if (error || !n) { report.errors.push(`${rule.key}: ${error?.message}`); continue; }
    report.delivered += await deliver(admin, userId, n as { id: string; title: string; body: string; deep_link: string | null; rule_key: string | null });
    // Mirror into the coach conversation so the agent "remembers" what it said.
    if (rule.kind !== 'agent') {
      await admin.from('agent_messages').insert({ user_id: userId, role: 'assistant', kind: 'proactive', text: body, parts: [{ type: 'text', text: body }], notification_id: n.id, meta: { rule: rule.key } });
    } else {
      await admin.from('agent_messages').update({ notification_id: n.id }).eq('user_id', userId).eq('kind', 'proactive').is('notification_id', null).gte('created_at', new Date(now.getTime() - 5 * 60_000).toISOString());
    }
    report.sent.push(rule.key);
  }
  return report;
}

/** Returns a reason to stay silent for agent-initiated messages, or null. */
async function agentGate(admin: SupabaseClient, userId: string, profile: Profile, now: Date): Promise<string | null> {
  const since = new Date(now.getTime() - 24 * 3600_000).toISOString();
  const { data: recent } = await admin.from('agent_messages').select('role, kind, created_at').eq('user_id', userId).gte('created_at', since).order('created_at', { ascending: false }).limit(30);
  const proactive = (recent ?? []).filter((m) => m.kind === 'proactive' && m.role === 'assistant');
  const cap = Math.min(AGENT_DAILY_CAP, profile.max_proactive_per_day);
  if (proactive.length >= cap) return 'agent_daily_cap';
  const lastAny = recent?.[0];
  if (lastAny && now.getTime() - Date.parse(lastAny.created_at as string) < Math.max(AGENT_MIN_GAP_MIN, profile.min_minutes_between_proactive) * 60_000 && lastAny.role === 'assistant') return 'agent_min_gap';
  // Silence after two unanswered nudges in a row (no user message in between).
  let unanswered = 0;
  for (const m of recent ?? []) {
    if (m.role === 'user') break;
    if (m.kind === 'proactive') unanswered++;
  }
  if (unanswered >= 2) return 'agent_unanswered';
  return null;
}

async function recordSuppressed(admin: SupabaseClient, userId: string, day: string, rule: Rule, reason: string) {
  await admin.from('notifications').insert({ user_id: userId, rule_key: rule.key, local_day: day, title: rule.title, body: '-', status: 'suppressed', suppression_reason: reason });
}

async function compose(userId: string, rule: Rule, facts: Facts): Promise<string> {
  const res = await genText({
    task: 'compose',
    log: { userId, purpose: 'compose' },
    system: 'Ты пишешь одно короткое push-уведомление (до 160 символов) от спокойного коуча по питанию. На «ты», без восклицательных знаков, без стыда, без мотивационной воды. Одно конкретное действие. Цифры бери только из данных. Никогда не советуй меньше 1500 ккал.',
    messages: [{ role: 'user', content: `Смысл напоминания: «${fillTemplate(rule.template, facts)}».\nДанные дня: ${JSON.stringify(pickFacts(facts))}\nНапиши текст уведомления.` }],
    temperature: 0.5,
    maxOutputTokens: 300,
    timeoutMs: 20_000,
  });
  const text = res.result.trim().replace(/^["«]|["»]$/g, '');
  if (text.length < 8) throw new Error('empty compose');
  return text;
}

function pickFacts(f: Facts) {
  return {
    time: f.local_time, kcal: f.kcal, protein_g: f.protein_g, protein_remaining: f.protein_remaining,
    kcal_remaining: f.kcal_remaining, meals: f.meals_count, training_day: f.is_training_day,
  };
}

/** After the day boundary, write yesterday's numbers as an episodic memory (once). */
async function summarizeYesterday(admin: SupabaseClient, userId: string, profile: Profile, now: Date) {
  const today = localParts(new Date(now.getTime() - profile.day_boundary_minutes * 60_000), profile.timezone).date;
  const yesterday = addDays(today, -1);
  const { data: exists } = await admin.from('memories').select('id').eq('user_id', userId).eq('kind', 'day_summary').eq('ref_day', yesterday).limit(1);
  if (exists?.length) return;
  const [{ data: t }, { data: slips }, { data: goals }] = await Promise.all([
    admin.from('day_totals').select('*').eq('user_id', userId).eq('local_day', yesterday).maybeSingle(),
    admin.from('slips').select('trigger').eq('user_id', userId).eq('local_day', yesterday),
    admin.from('goals').select('*').eq('user_id', userId).eq('is_current', true).lte('starts_on', yesterday).order('starts_on', { ascending: false }).limit(1),
  ]);
  if (!t) return; // nothing logged — nothing to summarize
  const g = goals?.[0];
  const kcal = Math.round(Number(t.kcal));
  const protein = Math.round(Number(t.protein_g));
  const inPlan = g ? kcal >= g.kcal_min && kcal <= g.kcal_max && protein >= g.protein_min_g : null;
  const content = `${yesterday}: ${kcal} ккал, белок ${protein} г, жиры ${Math.round(Number(t.fat_g))} г, углеводы ${Math.round(Number(t.carbs_g))} г; приёмов ${t.meals_count}. ${inPlan == null ? '' : inPlan ? 'В плане.' : 'Вне плана.'}${slips?.length ? ` Срывов: ${slips.length} (${slips.map((s) => s.trigger ?? '—').join(', ')}).` : ' Срывов нет.'}`;
  await admin.from('memories').insert({ user_id: userId, kind: 'day_summary', content, tags: ['итог дня'], importance: 2, status: 'active', source: 'system', ref_day: yesterday });
}
