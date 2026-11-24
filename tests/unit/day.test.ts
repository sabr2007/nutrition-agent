import { describe, expect, test } from 'vitest';
import { addDays, dayClockMin, instantForLocal, isoWeekdayOf, localDay, localParts } from '@/lib/nutrition/day';

describe('Asia/Almaty is UTC+5 (single KZ timezone since 2024)', () => {
  test('local parts', () => {
    const p = localParts(new Date('2026-11-24T06:30:00Z'), 'Asia/Almaty');
    expect(p.date).toBe('2026-11-24');
    expect(p.hhmm).toBe('11:30');
    expect(p.isoWeekday).toBe(2); // Tuesday
  });
});

describe('localDay with 04:00 boundary', () => {
  test('00:30 local belongs to the previous day', () => {
    // 2026-11-25 00:30 +05 = 2026-11-24 19:30Z
    expect(localDay(new Date('2026-11-24T19:30:00Z'))).toBe('2026-11-24');
  });
  test('03:59 local still previous day, 04:00 is the new day', () => {
    expect(localDay(new Date('2026-11-24T22:59:00Z'))).toBe('2026-11-24');
    expect(localDay(new Date('2026-11-24T23:00:00Z'))).toBe('2026-11-25');
  });
  test('boundary 0 behaves like calendar date', () => {
    expect(localDay(new Date('2026-11-24T19:30:00Z'), 'Asia/Almaty', 0)).toBe('2026-11-25');
  });
});

describe('instantForLocal', () => {
  test('evening time maps to the same calendar date', () => {
    expect(instantForLocal('2026-11-24', '21:00').toISOString()).toBe('2026-11-24T16:00:00.000Z');
  });
  test('after-midnight time maps to the next calendar date', () => {
    expect(instantForLocal('2026-11-24', '00:30').toISOString()).toBe('2026-11-24T19:30:00.000Z');
  });
  test('round trip with localDay', () => {
    const t = instantForLocal('2026-11-24', '02:15');
    expect(localDay(t)).toBe('2026-11-24');
  });
});

describe('helpers', () => {
  test('dayClockMin orders 00:30 after 21:00', () => {
    expect(dayClockMin('00:30')).toBeGreaterThan(dayClockMin('21:00'));
    expect(dayClockMin('04:00')).toBe(0);
  });
  test('isoWeekdayOf / addDays', () => {
    expect(isoWeekdayOf('2026-11-23')).toBe(1); // Monday
    expect(isoWeekdayOf('2026-11-29')).toBe(7);
    expect(addDays('2026-11-30', 1)).toBe('2026-12-01');
  });
});
