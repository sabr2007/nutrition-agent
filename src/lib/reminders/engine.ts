import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getProfile, type Profile } from '@/lib/data/profile';
import { localParts, addDays } from '@/lib/nutrition/day';
import { genText } from '@/lib/llm/generate';
import { runAgent } from '@/lib/agent/run';
import { deliver, type Deliver, type Outgoing } from './deliver';
import { evaluate, fillTemplate, inQuietHours, minutesSince, type Condition, type Facts } from './dsl';
import { computeFacts } from './facts';
import { agentGate, ruleSilence, type DayNotification } from './limits';

type Rule = {
  id: string; key: string; title: string; kind: 'schedule' | 'context' | 'agent'; enabled: boolean;
  at_time: string | null; window_minutes: number; days: number[] | null; training_days_only: boolean;
  condition: Condition; template: string; compose_with_llm: boolean; skill_key: string | null;
  priority: number; cooldown_minutes: number; once_per_day: boolean; deep_link: string;
};

export type TickReport = { userId: string; considered: number; sent: string[]; skipped: Record<string, string>; delivered: number; errors: string[] };

/** The rule whose message asks «ate anything?» with its own buttons. */
const FOOD_CHECK_RULE = 'no_food_5h';
const DUE_BATCH = 5;
const DAY_MS = 24 * 3600_000;

/** `preview`: evaluate the rules at `now` and report what would be sent — nothing is sent, written or asked of the agent. */
export type TickOptions = { preview?: boolean };

export async function runTick(admin: SupabaseClient, now = new Date(), send: Deliver = deliver, opts: TickOptions = {}): Promise<TickReport[]> {
  const { data: users } = await admin.from('profiles').select('user_id');
  const reports: TickReport[] = [];
  for (const u of users ?? []) {
    try {
      reports.push(await tickUser(admin, u.user_id as string, now, send, opts));
    } catch (e) {
      reports.push({ userId: u.user_id as string, considered: 0, sent: [], skipped: {}, delivered: 0, errors: [(e as Error).message.slice(0, 200)] });
    }
  }
  return reports;
}

async function mutedUntilFor(admin: SupabaseClient, userId: string): Promise<number | null> {
  const { data } = await admin.from('tg_chats').select('muted_until').eq('user_id', userId).not('muted_until', 'is', null).order('muted_until', { ascending: false }).limit(1);
  return data?.[0]?.muted_until ? Date.parse(data[0].muted_until as string) : null;
}

/** What the limits need: today's notifications, bot messages of the last 24 h, the owner's last sign of life. */
async function limitState(admin: SupabaseClient, userId: string, day: string, now: Date) {
  const [{ data: todays }, { data: recent }, { data: lastUser }, { data: lastReaction }] = await Promise.all([
    admin.from('notifications').select('rule_key, status, sent_at, created_at, reaction').eq('user_id', userId).eq('local_day', day),
    admin.from('notifications').select('sent_at').eq('user_id', userId).eq('status', 'sent').gte('sent_at', new Date(now.getTime() - DAY_MS).toISOString()),
    admin.from('agent_messages').select('created_at').eq('user_id', userId).eq('role', 'user').order('created_at', { ascending: false }).limit(1),
    admin.from('notifications').select('acted_at').eq('user_id', userId).not('acted_at', 'is', null).order('acted_at', { ascending: false }).limit(1),
  ]);
  const today: DayNotification[] = (todays ?? []).map((n) => ({
    key: (n.rule_key as string) ?? null, status: n.status as string, reaction: (n.reaction as string) ?? null,
    sentAt: n.sent_at ? Date.parse(n.sent_at as string) : null, createdAt: Date.parse(n.created_at as string),
  }));
  const owner = [lastUser?.[0]?.created_at, lastReaction?.[0]?.acted_at].filter((t): t is string => Boolean(t)).map((t) => Date.parse(t));
  return { today, botSentAt: (recent ?? []).map((n) => Date.parse(n.sent_at as string)), lastOwnerAt: owner.length ? Math.max(...owner) : null };
}

async function tickUser(admin: SupabaseClient, userId: string, now: Date, send: Deliver, opts: TickOptions): Promise<TickReport> {
  const report: TickReport = { userId, considered: 0, sent: [], skipped: {}, delivered: 0, errors: [] };
  const profile = await getProfile(admin, userId);
  const local = localParts(now, profile.timezone);
  const quiet = inQuietHours(local.hhmm, profile.quiet_start.slice(0, 5), profile.quiet_end.slice(0, 5));
  const mutedUntil = await mutedUntilFor(admin, userId);
  const muted = mutedUntil != null && mutedUntil > now.getTime();

  // 1) Due one-off notifications (snoozes, agent-scheduled reminders) — they wait out quiet hours and /mute.
  if (!quiet && !muted && !opts.preview) {
    const { data: due } = await admin.from('notifications').select('id, title, body, deep_link, rule_key, payload').eq('user_id', userId).eq('status', 'pending').lte('scheduled_for', now.toISOString()).limit(DUE_BATCH);
    for (const n of due ?? []) {
      report.delivered += await send(admin, userId, n as Outgoing);
      report.sent.push(`pending:${n.rule_key ?? n.id}`);
    }
  }

  // 2) Day rollover: deterministic episodic summary of yesterday (no LLM needed).
  if (!opts.preview) await summarizeYesterday(admin, userId, profile, now).catch((e) => report.errors.push(`summary: ${(e as Error).message.slice(0, 120)}`));

  if (muted || quiet) {
    report.skipped['*'] = muted ? 'muted' : 'quiet_hours';
    return report;
  }

  // 3) Rules — cheap SQL/logic gate first; the LLM is only called for rules that fire.
  const { data: rules } = await admin.from('reminder_rules').select('*').eq('user_id', userId).eq('enabled', true).order('sort_order');
  if (!rules?.length) return report;
  const { facts, summary } = await computeFacts(admin, userId, profile, now);
  const state = await limitState(admin, userId, summary.day, now);
  let today = state.today;
  let botSentAt = state.botSentAt;
  const agentKeys = new Set((rules as Rule[]).filter((r) => r.kind === 'agent').map((r) => r.key));

  for (const rule of rules as Rule[]) {
    report.considered++;
    const skip = (why: string) => { report.skipped[rule.key] = why; };
    const silence = ruleSilence({ nowMs: now.getTime(), mutedUntil, quiet, rule, today });
    if (silence) { skip(silence); continue; }
    if (rule.days?.length && !rule.days.includes(local.isoWeekday)) { skip('weekday'); continue; }
    if (rule.training_days_only && !summary.trainingDay) { skip('not_training_day'); continue; }
    if (rule.at_time) {
      const since = minutesSince(local.hhmm, rule.at_time.slice(0, 5));
      if (since > rule.window_minutes) { skip('outside_window'); continue; }
    }
    if (!evaluate(rule.condition, facts)) { skip('condition_false'); continue; }

    let body: string | null = null;
    const payload: NonNullable<Outgoing['payload']> = { buttons: rule.kind === 'agent' ? 'agent' : rule.key === FOOD_CHECK_RULE ? 'food_check' : 'reminder' };
    if (rule.kind === 'agent') {
      const gate = agentGate({
        nowMs: now.getTime(), maxPerDay: profile.max_proactive_per_day, minGapMin: profile.min_minutes_between_proactive,
        agentSentToday: today.filter((n) => n.status === 'sent' && n.key != null && agentKeys.has(n.key)).length, botSentAt, lastOwnerAt: state.lastOwnerAt,
      });
      if (gate) { skip(gate); continue; }
      if (opts.preview) { report.sent.push(`${rule.key}:agent`); continue; }
      const sentToday = today.filter((n) => n.status === 'sent').length;
      const r = await runAgent({ sb: admin, userId, trigger: 'cron', skillKey: rule.skill_key ?? 'proactive_checkin', proactive: { reason: rule.title, ruleKey: rule.key, template: rule.template, sentToday, lastSentAt: botSentAt.length ? localParts(new Date(Math.max(...botSentAt)), profile.timezone).hhmm : null }, now });
      if (r.decision !== 'sent') { skip(`agent_${r.decision}`); await recordSuppressed(admin, userId, summary.day, rule, `agent:${r.decision}`); continue; }
      body = r.text;
      payload.suggestions = (r.ui.suggestions ?? []).map((o) => ({ title: o.title, kcal: o.kcal, items: o.items }));
    } else if (opts.preview) {
      report.sent.push(`${rule.key}: ${fillTemplate(rule.template, facts).slice(0, 120)}`);
      continue;
    } else if (rule.compose_with_llm) {
      body = await compose(userId, rule, facts).catch(() => null);
    }
    body = body ?? fillTemplate(rule.template, facts);

    const { data: n, error } = await admin.from('notifications').insert({
      user_id: userId, rule_key: rule.key, local_day: summary.day, title: rule.kind === 'agent' ? 'Рядом' : rule.title,
      body, deep_link: rule.deep_link, status: 'pending', payload: { facts: pickFacts(facts), ...payload },
    }).select('id, title, body, deep_link, rule_key, payload').single();
    if (error || !n) { report.errors.push(`${rule.key}: ${error?.message}`); continue; }
    report.delivered += await send(admin, userId, n as Outgoing);
    // Mirror into the coach conversation so the agent "remembers" what it said.
    if (rule.kind !== 'agent') {
      await admin.from('agent_messages').insert({ user_id: userId, role: 'assistant', kind: 'proactive', text: body, parts: [{ type: 'text', text: body }], notification_id: n.id, meta: { rule: rule.key } });
    } else {
      await admin.from('agent_messages').update({ notification_id: n.id }).eq('user_id', userId).eq('kind', 'proactive').is('notification_id', null).gte('created_at', new Date(now.getTime() - 5 * 60_000).toISOString());
    }
    // The next rules of this tick see this message (gap, cap, once per day).
    today = [...today, { key: rule.key, status: 'sent', reaction: null, sentAt: now.getTime(), createdAt: now.getTime() }];
    botSentAt = [...botSentAt, now.getTime()];
    report.sent.push(rule.key);
  }
  return report;
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
    timeoutMs: 30_000,
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
