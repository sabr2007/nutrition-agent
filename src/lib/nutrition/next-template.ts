import { dayClockMin, localParts } from './day';

// Templates due «now» (the one-tap «по плану» logic): not yet logged today, scheduled within
// the next 90 minutes or overdue, training-day-only ones only on training days.

export type TemplateLike = { id: string; name: string; default_time: string | null; training_day_only: boolean };
export type DayLike = {
  trainingDay: boolean;
  meals: { template_id: string | null }[];
  profile: { timezone: string; day_boundary_minutes: number };
};

const AHEAD_MIN = 90;

export function dueTemplates<T extends TemplateLike>(templates: T[], day: DayLike, now = new Date(), limit = 3): T[] {
  const nowMin = dayClockMin(localParts(now, day.profile.timezone).hhmm, day.profile.day_boundary_minutes);
  const logged = new Set(day.meals.map((m) => m.template_id).filter(Boolean));
  const candidates = templates
    .filter((t) => t.default_time && (!t.training_day_only || day.trainingDay))
    .filter((t) => !logged.has(t.id))
    .map((t) => ({ t, at: dayClockMin(t.default_time!, day.profile.day_boundary_minutes) }))
    .sort((a, b) => a.at - b.at);
  const due = candidates.filter((c) => c.at <= nowMin + AHEAD_MIN);
  // The most recent due ones first, then the next upcoming one.
  const ordered = [...due.reverse(), ...candidates.filter((c) => c.at > nowMin + AHEAD_MIN)];
  return ordered.slice(0, limit).map((c) => c.t);
}
