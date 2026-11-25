import { describe, expect, test } from 'vitest';
import { agentGate, ruleSilence, unansweredCount, type DayNotification } from '@/lib/reminders/limits';
import { evaluate, inQuietHours } from '@/lib/reminders/dsl';
import { buildNotification } from '@/lib/telegram/notify';

const T = (hhmm: string) => Date.parse(`2026-11-26T${hhmm}:00+05:00`);
const min = 60_000;
const rule = { key: 'creatine', once_per_day: true, cooldown_minutes: 120 };
const sent = (key: string, at: number, extra: Partial<DayNotification> = {}): DayNotification => ({ key, status: 'sent', reaction: null, sentAt: at, createdAt: at, ...extra });
const silence = (over: Partial<Parameters<typeof ruleSilence>[0]> = {}) => ruleSilence({ nowMs: T('12:30'), mutedUntil: null, quiet: false, rule, today: [], ...over });

describe('every rule: quiet hours, /mute, «Не сегодня», dedupe', () => {
  test('quiet hours over midnight, as in the profile (02:45–11:00)', () => {
    expect(inQuietHours('03:10', '02:45', '11:00')).toBe(true);
    expect(inQuietHours('10:59', '02:45', '11:00')).toBe(true);
    expect(inQuietHours('11:00', '02:45', '11:00')).toBe(false);
    expect(inQuietHours('23:30', '23:00', '07:00')).toBe(true);
    expect(silence({ quiet: true })).toBe('quiet_hours');
  });
  test('/mute silences until its end, then the rule may speak', () => {
    expect(silence({ mutedUntil: T('14:00') })).toBe('muted');
    expect(silence({ mutedUntil: T('12:00') })).toBeNull();
  });
  test('«Не сегодня» silences this rule for the rest of the day, not the others', () => {
    const today = [sent('creatine', T('12:15'), { reaction: 'not_today' })];
    expect(silence({ today, rule: { ...rule, once_per_day: false, cooldown_minutes: 0 } })).toBe('not_today');
    expect(silence({ today, rule: { key: 'protein_1', once_per_day: true, cooldown_minutes: 60 } })).toBeNull();
  });
  test('once a day: a sent one blocks the next, a suppressed one does not', () => {
    expect(silence({ today: [sent('creatine', T('12:15'))] })).toBe('already_today');
    expect(silence({ today: [sent('creatine', T('12:15'), { status: 'suppressed' })] })).toBeNull();
  });
  test('cooldown for repeating rules', () => {
    const repeating = { key: 'no_food_5h', once_per_day: false, cooldown_minutes: 300 };
    const today = [sent('no_food_5h', T('12:00'))];
    expect(silence({ rule: repeating, today, nowMs: T('12:00') + 299 * min })).toBe('cooldown');
    expect(silence({ rule: repeating, today, nowMs: T('12:00') + 301 * min })).toBeNull();
  });
});

describe('the agent’s own messages: cap, 90-minute gap, 3 without a reaction', () => {
  const base = { nowMs: T('16:00'), maxPerDay: 6, minGapMin: 90, agentSentToday: 0, botSentAt: [] as number[], lastOwnerAt: null as number | null };
  test('daily cap comes from the profile', () => {
    expect(agentGate({ ...base, agentSentToday: 6 })).toBe('agent_daily_cap');
    expect(agentGate({ ...base, agentSentToday: 5 })).toBeNull();
    expect(agentGate({ ...base, agentSentToday: 2, maxPerDay: 2 })).toBe('agent_daily_cap');
  });
  test('at least 90 minutes after any bot message; a longer profile gap wins', () => {
    expect(agentGate({ ...base, botSentAt: [T('16:00') - 89 * min] })).toBe('agent_min_gap');
    expect(agentGate({ ...base, botSentAt: [T('16:00') - 91 * min], lastOwnerAt: T('16:00') - 60 * min })).toBeNull();
    expect(agentGate({ ...base, minGapMin: 25, botSentAt: [T('16:00') - 60 * min] })).toBe('agent_min_gap');
    expect(agentGate({ ...base, minGapMin: 180, botSentAt: [T('16:00') - 120 * min], lastOwnerAt: T('15:59') })).toBe('agent_min_gap');
  });
  test('three bot messages in a row without a reaction → silence until the owner writes or presses', () => {
    const three = [T('09:00'), T('11:00'), T('13:00')];
    expect(unansweredCount(three, null)).toBe(3);
    expect(agentGate({ ...base, botSentAt: three })).toBe('agent_unanswered');
    expect(agentGate({ ...base, botSentAt: three, lastOwnerAt: T('12:00') })).toBeNull();
    expect(unansweredCount(three, T('13:30'))).toBe(0);
  });
});

describe('new rules read the activity facts', () => {
  const morning = { any: [{ fact: 'minutes_since_wake', op: 'between', value: [15, 120] }, { all: [{ fact: 'minutes_since_wake', op: 'is_null' }, { fact: 'minutes_since_quiet_end', op: 'between', value: [15, 90] }] }] } as const;
  test('morning: after the sleep ends; without sleep data — after the quiet hours', () => {
    expect(evaluate(morning as never, { minutes_since_wake: 20 })).toBe(true);
    expect(evaluate(morning as never, { minutes_since_wake: 200, minutes_since_quiet_end: 30 })).toBe(false);
    expect(evaluate(morning as never, { minutes_since_wake: null, minutes_since_quiet_end: 30 })).toBe(true);
    expect(evaluate(morning as never, { minutes_since_wake: null, minutes_since_quiet_end: 5 })).toBe(false);
  });
  test('steps by 18:00 only with step data', () => {
    const steps = { all: [{ fact: 'steps', op: 'not_null' }, { fact: 'steps_pct', op: 'lt', value: 50 }] } as const;
    expect(evaluate(steps as never, { steps: 3000, steps_pct: 30 })).toBe(true);
    expect(evaluate(steps as never, { steps: null, steps_pct: null })).toBe(false);
  });
});

describe('reminder buttons in Telegram', () => {
  let i = 0;
  const id = () => `id${++i}`;
  test('a reminder: ✓ Сделал · ⏰ 15 мин · 🔕 Не сегодня', () => {
    const b = buildNotification({ id: 'n1', body: 'Креатин 5 г', buttons: 'reminder' }, { userId: 'u', chatId: 1 }, id);
    expect(b.keyboard?.inline_keyboard.map((r) => r.map((x) => x.text))).toEqual([['✓ Сделал', '⏰ 15 мин', '🔕 Не сегодня']]);
    expect(b.callbacks.map((c) => c.payload)).toEqual([
      { notification_id: 'n1', action: 'done' }, { notification_id: 'n1', action: 'snooze', minutes: 15 }, { notification_id: 'n1', action: 'not_today' },
    ]);
  });
  test('an agent message: its «Записать» options, then 🔕', () => {
    const b = buildNotification({ id: 'n2', body: '**Белка мало**: творог 200 г', buttons: 'agent', suggestions: [{ title: 'Творог 5% 200 г', kcal: 242, items: [{ food_id: 'f', name: 'Творог 5%', grams: 200 }] }] }, { userId: 'u', chatId: 1 }, id);
    expect(b.messages[0]).toContain('<b>Белка мало</b>');
    expect(b.keyboard?.inline_keyboard.map((r) => r.map((x) => x.text))).toEqual([['Записать: Творог 5% 200 г · 242 ккал'], ['🔕 Не сегодня']]);
    expect(b.callbacks[0].kind).toBe('log_option');
  });
  test('long without food: Ел, сейчас запишу · Не ел · Позже', () => {
    const b = buildNotification({ id: 'n3', body: 'Больше пяти часов без записей еды. Ел что-нибудь?', buttons: 'food_check' }, { userId: 'u', chatId: 1 }, id);
    expect(b.keyboard?.inline_keyboard.map((r) => r.map((x) => x.text))).toEqual([['Ел, сейчас запишу'], ['Не ел', 'Позже']]);
    expect(b.callbacks.find((c) => (c.payload as { action: string }).action === 'snooze')?.payload).toMatchObject({ minutes: 60 });
  });
});
