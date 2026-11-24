import { describe, expect, test } from 'vitest';
import { evaluate, fillTemplate, inQuietHours, minutesSince } from '@/lib/reminders/dsl';

const facts = { meals_count: 0, protein_remaining: 75, minutes_since_workout_end: 35, checked: { weigh: true, creatine: false }, logged_slot: { breakfast: true } };

describe('reminder DSL', () => {
  test('simple comparisons', () => {
    expect(evaluate({ fact: 'meals_count', op: 'eq', value: 0 }, facts)).toBe(true);
    expect(evaluate({ fact: 'protein_remaining', op: 'gt', value: 60 }, facts)).toBe(true);
    expect(evaluate({ fact: 'protein_remaining', op: 'gt', value: 80 }, facts)).toBe(false);
  });
  test('nested facts and missing keys default to false', () => {
    expect(evaluate({ fact: 'checked.creatine', op: 'eq', value: false }, facts)).toBe(true);
    expect(evaluate({ fact: 'checked.protein_2', op: 'eq', value: false }, facts)).toBe(true);
    expect(evaluate({ fact: 'logged_slot.lunch', op: 'eq', value: false }, facts)).toBe(true);
  });
  test('all / any / not / between', () => {
    const postWorkout = { all: [{ fact: 'minutes_since_workout_end', op: 'between', value: [30, 50] }, { fact: 'checked.protein_2', op: 'eq', value: false }] } as const;
    expect(evaluate(postWorkout as never, facts)).toBe(true);
    expect(evaluate({ any: [{ fact: 'checked.weigh', op: 'eq', value: false }, { fact: 'logged_slot.breakfast', op: 'eq', value: false }] } as never, facts)).toBe(false);
    expect(evaluate({ not: { fact: 'meals_count', op: 'gt', value: 0 } } as never, facts)).toBe(true);
  });
  test('empty condition always fires', () => {
    expect(evaluate({}, facts)).toBe(true);
    expect(evaluate(null, facts)).toBe(true);
  });
  test('null-safe numeric ops', () => {
    expect(evaluate({ fact: 'minutes_since_last_meal', op: 'gt', value: 10 }, facts)).toBe(false);
    expect(evaluate({ fact: 'minutes_since_last_meal', op: 'is_null' }, facts)).toBe(true);
  });
});

describe('time helpers', () => {
  test('minutesSince wraps midnight', () => {
    expect(minutesSince('00:10', '23:50')).toBe(20);
    expect(minutesSince('21:15', '21:00')).toBe(15);
    expect(minutesSince('20:59', '21:00')).toBe(1439);
  });
  test('quiet hours across midnight', () => {
    expect(inQuietHours('03:00', '23:00', '08:00')).toBe(true);
    expect(inQuietHours('08:00', '23:00', '08:00')).toBe(false);
    expect(inQuietHours('22:45', '23:00', '08:00')).toBe(false);
    expect(inQuietHours('23:30', '23:00', '07:00')).toBe(true);
    expect(inQuietHours('12:00', '23:00', '07:00')).toBe(false);
  });
  test('fillTemplate', () => {
    expect(fillTemplate('До цели ещё {protein_remaining} г.{training_hint}', { protein_remaining: 75, training_hint: '' })).toBe('До цели ещё 75 г.');
  });
});
