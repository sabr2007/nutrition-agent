// Limits on proactive messages (D29, revises D12). Pure functions over what the tick gathered, so
// they are tested with a fake clock.
//  * Everything is silenced by /mute and the quiet hours; a rule is silenced for the local day by
//    «🔕 Не сегодня»; once-per-day rules and cooldowns dedupe.
//  * The agent's own messages (kind 'agent') also have a daily cap (profiles.max_proactive_per_day),
//    a gap of at least 90 minutes after any bot message, and go quiet after 3 bot messages in a
//    row without a reaction (a message or any button) — until the owner writes.
//  * Reminders the owner set up (kind 'schedule' / 'context') are not capped.

export const AGENT_MIN_GAP_MIN = 90;
export const UNANSWERED_LIMIT = 3;

export type DayNotification = { key: string | null; status: string; reaction: string | null; sentAt: number | null; createdAt: number };

export type RuleGateInput = {
  nowMs: number;
  mutedUntil: number | null;
  quiet: boolean;
  rule: { key: string; once_per_day: boolean; cooldown_minutes: number };
  today: DayNotification[];
};

/** Why a rule stays silent before its condition is even looked at, or null. */
export function ruleSilence(i: RuleGateInput): string | null {
  if (i.mutedUntil != null && i.mutedUntil > i.nowMs) return 'muted';
  if (i.quiet) return 'quiet_hours';
  const mine = i.today.filter((n) => n.key === i.rule.key);
  if (mine.some((n) => n.reaction === 'not_today')) return 'not_today';
  const already = mine.filter((n) => n.status !== 'suppressed');
  if (i.rule.once_per_day && already.length) return 'already_today';
  const last = Math.max(0, ...already.map((n) => n.sentAt ?? n.createdAt));
  if (last && i.nowMs - last < i.rule.cooldown_minutes * 60_000) return 'cooldown';
  return null;
}

export type AgentGateInput = {
  nowMs: number;
  maxPerDay: number;
  minGapMin: number;
  /** Agent-kind messages sent today. */
  agentSentToday: number;
  /** When each bot-initiated message (any kind) was sent, recent first or not. */
  botSentAt: number[];
  /** The owner's last message or button press. */
  lastOwnerAt: number | null;
};

export function unansweredCount(botSentAt: number[], lastOwnerAt: number | null): number {
  return botSentAt.filter((t) => lastOwnerAt == null || t > lastOwnerAt).length;
}

/** Extra limits for the agent's own messages, or null when it may write. */
export function agentGate(i: AgentGateInput): string | null {
  if (i.agentSentToday >= i.maxPerDay) return 'agent_daily_cap';
  const lastBot = i.botSentAt.length ? Math.max(...i.botSentAt) : null;
  if (lastBot != null && i.nowMs - lastBot < Math.max(AGENT_MIN_GAP_MIN, i.minGapMin) * 60_000) return 'agent_min_gap';
  if (unansweredCount(i.botSentAt, i.lastOwnerAt) >= UNANSWERED_LIMIT) return 'agent_unanswered';
  return null;
}
