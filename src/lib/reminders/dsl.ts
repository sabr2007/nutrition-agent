// Tiny condition language for reminder rules (stored as JSON in reminder_rules.condition).
//   {"fact": "checked.weigh", "op": "eq", "value": false}
//   {"all": [ ... ]}  {"any": [ ... ]}  {"not": { ... }}
// Facts are flat keys; dotted keys address nested maps (checked.<key>, logged_slot.<slot>).

export type Condition =
  | { all: Condition[] }
  | { any: Condition[] }
  | { not: Condition }
  | { fact: string; op: Op; value?: unknown }
  | Record<string, never>;

export type Op = 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'between' | 'in' | 'is_null' | 'not_null';

export type Facts = Record<string, unknown>;

function read(facts: Facts, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, k) => (acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[k] : undefined), facts);
}

export function evaluate(cond: Condition | null | undefined, facts: Facts): boolean {
  if (!cond || Object.keys(cond).length === 0) return true;
  if ('all' in cond) return cond.all.every((c) => evaluate(c, facts));
  if ('any' in cond) return cond.any.some((c) => evaluate(c, facts));
  if ('not' in cond) return !evaluate(cond.not, facts);
  if ('fact' in cond) {
    const v = read(facts, cond.fact);
    const target = cond.value;
    switch (cond.op) {
      case 'eq': return (v ?? false) === target;
      case 'ne': return (v ?? false) !== target;
      case 'gt': return typeof v === 'number' && v > Number(target);
      case 'gte': return typeof v === 'number' && v >= Number(target);
      case 'lt': return typeof v === 'number' && v < Number(target);
      case 'lte': return typeof v === 'number' && v <= Number(target);
      case 'between': {
        const [lo, hi] = target as [number, number];
        return typeof v === 'number' && v >= lo && v <= hi;
      }
      case 'in': return Array.isArray(target) && target.includes(v);
      case 'is_null': return v == null;
      case 'not_null': return v != null;
    }
  }
  return false;
}

/** Fills {placeholders} in rule templates from facts. */
export function fillTemplate(tpl: string, facts: Facts): string {
  return tpl.replace(/\{(\w+(?:\.\w+)?)\}/g, (_, key: string) => {
    const v = read(facts, key);
    return v == null ? '' : String(v);
  }).replace(/\s{2,}/g, ' ').trim();
}

/** Minutes since `at` on a clock that wraps at midnight (handles 23:50 → 00:10). */
export function minutesSince(nowHHMM: string, atHHMM: string): number {
  const toMin = (s: string) => { const [h, m] = s.split(':').map(Number); return h * 60 + (m || 0); };
  return (toMin(nowHHMM) - toMin(atHHMM) + 1440) % 1440;
}

export function inQuietHours(nowHHMM: string, start: string, end: string): boolean {
  if (start === end) return false;
  const n = nowHHMM;
  return start < end ? n >= start && n < end : n >= start || n < end;
}
