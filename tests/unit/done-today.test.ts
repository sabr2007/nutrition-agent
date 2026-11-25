import { describe, expect, test } from 'vitest';
import { doneToday } from '@/lib/reminders/done';

const meal = (slot: string | null, names: string[], template_id: string | null = null) => ({ slot, template_id, items: names.map((name) => ({ name })) });

describe('done today, without a checklist (D30)', () => {
  test('slots, templates, shakes by count, creatine, late cottage cheese, weight, ✓ reactions', () => {
    const done = doneToday({
      meals: [meal('breakfast', ['Яйцо', 'Овсянка']), meal('snack', ['Протеин сывороточный']), meal('snack', ['Креатин']), meal('late', ['Творог 5%']), meal('snack', ['Whey'], 't-shake')],
      templateKeys: new Map([['t-shake', 'protein']]),
      reactedDone: ['prep_chicken'],
      weighed: true,
    });
    expect(done).toEqual({ breakfast: true, protein_1: true, protein_2: true, creatine: true, tvorog: true, weigh: true, prep_chicken: true });
  });
  test('one shake is protein_1 only; ✓ under the post-workout reminder closes protein_2', () => {
    expect(doneToday({ meals: [meal('snack', ['Протеин'])], templateKeys: new Map(), reactedDone: [], weighed: false })).toEqual({ protein_1: true });
    expect(doneToday({ meals: [], templateKeys: new Map(), reactedDone: ['post_workout_protein'], weighed: false })).toEqual({ post_workout_protein: true, protein_2: true });
  });
  test('a template with its own done key marks it', () => {
    expect(doneToday({ meals: [meal('lunch', ['Грудка'], 't-lunch')], templateKeys: new Map([['t-lunch', 'lunch_box']]), reactedDone: [], weighed: false })).toEqual({ lunch: true, lunch_box: true });
  });
});
