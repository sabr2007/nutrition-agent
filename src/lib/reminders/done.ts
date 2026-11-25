// What is already done today (D30), for reminder conditions «done.<key>». The checklist used to be
// ticked by hand or by logging; now it is read from what happened:
//  * a meal in a slot (breakfast / lunch / dinner), or a template with a `done_key`;
//  * protein shakes by count (first → protein_1, second → protein_2), creatine, late cottage cheese;
//  * a weight measured today → weigh;
//  * a reminder answered with «✓ Сделал» in Telegram → its rule key (post-workout protein → protein_2).

export type DoneInput = {
  meals: { slot: string | null; template_id: string | null; items: { name: string }[] }[];
  /** meal_templates.id → done_key */
  templateKeys: Map<string, string>;
  /** Rule keys of today's notifications answered with ✓. */
  reactedDone: string[];
  weighed: boolean;
};

const SLOT_KEYS: Record<string, string> = { breakfast: 'breakfast', lunch: 'lunch', dinner: 'dinner' };
const SHAKE = /протеин|whey/i;
/** Reminders whose ✓ closes a differently named key. */
const REACTION_ALIASES: Record<string, string> = { post_workout_protein: 'protein_2' };

export function doneToday(i: DoneInput): Record<string, boolean> {
  const done: Record<string, boolean> = {};
  let shakes = 0;
  for (const m of i.meals) {
    if (m.slot && SLOT_KEYS[m.slot]) done[SLOT_KEYS[m.slot]] = true;
    const key = m.template_id ? i.templateKeys.get(m.template_id) : undefined;
    const isShake = key?.startsWith('protein') || m.items.some((it) => SHAKE.test(it.name));
    if (isShake) shakes++;
    else if (key) done[key] = true;
    if (m.items.some((it) => /креатин/i.test(it.name))) done.creatine = true;
    if (m.slot === 'late' && m.items.some((it) => /творог/i.test(it.name))) done.tvorog = true;
  }
  if (shakes >= 1) done.protein_1 = true;
  if (shakes >= 2) done.protein_2 = true;
  if (i.weighed) done.weigh = true;
  for (const k of i.reactedDone) {
    done[k] = true;
    if (REACTION_ALIASES[k]) done[REACTION_ALIASES[k]] = true;
  }
  return done;
}
