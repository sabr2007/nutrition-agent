import { describe, expect, test } from 'vitest';
import { dateKey, localDate, parseDailyRollup, parseExercise, parseRestingHr, parseSleep, rollupRange, seconds } from '@/lib/health/parse';
import { activityLines, type DayActivity } from '@/lib/health/activity';

// Samples from the Google Health API docs (docs/research/google-health-api.md).
const STEPS = { rollupDataPoints: [{ civilStartTime: { date: { year: 2026, month: 2, day: 26 }, time: {} }, civilEndTime: { date: { year: 2026, month: 2, day: 27 }, time: {} }, steps: { countSum: '3822' } }] };
const SLEEP = {
  dataPoints: [{
    dataPointName: 'users/user-id/dataTypes/sleep/dataPoints/data-point-id',
    sleep: {
      interval: { startTime: '2026-03-03T20:57:30Z', startUtcOffset: '0s', endTime: '2026-03-04T04:41:30Z', endUtcOffset: '0s' },
      type: 'STAGES', metadata: { stagesStatus: 'SUCCEEDED', processed: true, mainSleep: true },
      summary: { minutesInSleepPeriod: '464', minutesAsleep: '407', minutesAwake: '57', stagesSummary: [{ type: 'AWAKE', minutes: '56', count: '12' }, { type: 'LIGHT', minutes: '198', count: '19' }, { type: 'DEEP', minutes: '114', count: '10' }, { type: 'REM', minutes: '94', count: '4' }] },
    },
  }],
  nextPageToken: '',
};
const EXERCISE = {
  dataPoints: [{
    name: 'users/123/dataTypes/exercise/dataPoints/8896720705097069096',
    dataSource: { recordingMethod: 'MANUAL', platform: 'FITBIT' },
    exercise: { interval: { startTime: '2026-02-23T13:10:00Z', startUtcOffset: '-18000s', endTime: '2026-02-23T13:25:00Z', endUtcOffset: '-18000s' }, exerciseType: 'WALKING', metricsSummary: { caloriesKcal: 16, steps: '2038', averageHeartRateBeatsPerMinute: '81' }, displayName: 'Walk', activeDuration: '900s' },
  }],
  nextPageToken: '',
};
const RESTING = { dataPoints: [{ dataSource: { recordingMethod: 'DERIVED', platform: 'FITBIT' }, dailyRestingHeartRate: { date: { year: 2026, month: 11, day: 25 }, beatsPerMinute: '58' } }], nextPageToken: '' };

describe('Google Health parsing', () => {
  test('helpers', () => {
    expect(dateKey({ year: 2026, month: 2, day: 6 })).toBe('2026-02-06');
    expect(dateKey({})).toBeNull();
    expect(seconds('900s')).toBe(900);
    expect(seconds('-18000s')).toBe(-18000);
    expect(localDate('2026-11-25T20:30:00Z', '18000s')).toBe('2026-11-26');
  });
  test('daily rollup of steps (strings) and calories', () => {
    expect(parseDailyRollup(STEPS, 'steps')).toEqual({ '2026-02-26': 3822 });
    expect(parseDailyRollup({ rollupDataPoints: [{ civilStartTime: { date: { year: 2026, month: 11, day: 25 } }, totalCalories: { kcalSum: 2412.5 } }] }, 'total')).toEqual({ '2026-11-25': 2412.5 });
    expect(parseDailyRollup({ rollupDataPoints: [{ civilStartTime: { date: { year: 2026, month: 11, day: 25 } } }] }, 'active')).toEqual({});
    expect(parseDailyRollup(null, 'steps')).toEqual({});
  });
  test('resting heart rate', () => {
    expect(parseRestingHr(RESTING)).toEqual({ '2026-11-25': 58 });
  });
  test('sleep: main sleep on its wake-up day, minutes asleep and stages', () => {
    expect(parseSleep(SLEEP)).toEqual([{ night_of: '2026-03-04', start_at: '2026-03-03T20:57:30Z', end_at: '2026-03-04T04:41:30Z', minutes: 407, stages: { awake: 56, light: 198, deep: 114, rem: 94 } }]);
  });
  test('sleep: naps are skipped, the longest main sleep wins', () => {
    const nap = { sleep: { ...SLEEP.dataPoints[0].sleep, metadata: { mainSleep: false } } };
    expect(parseSleep({ dataPoints: [nap] })).toEqual([]);
  });
  test('exercise: local day from the offset, active minutes, kcal and heart rate', () => {
    expect(parseExercise(EXERCISE)).toEqual([{ external_id: '8896720705097069096', local_day: '2026-02-23', kind: 'walking', started_at: '2026-02-23T13:10:00Z', ended_at: '2026-02-23T13:25:00Z', duration_min: 15, kcal: 16, avg_hr: 81 }]);
  });
  test('rollup range is closed-open in civil dates', () => {
    expect(rollupRange('2026-11-24', '2026-11-26')).toEqual({ range: { start: { date: { year: 2026, month: 11, day: 24 }, time: {} }, end: { date: { year: 2026, month: 11, day: 26 }, time: {} } }, windowSizeDays: 1 });
  });
});

describe('activity in the agent snapshot', () => {
  const day: DayActivity = {
    day: '2026-11-26', steps: 4210, active_kcal: 180, total_kcal: null, resting_hr: 61,
    sleep: { minutes: 300, start: '2026-11-25T20:30:00Z', end: '2026-11-26T01:30:00Z', stages: { deep: 52 } },
    workouts: [{ kind: 'strength_training', start: '2026-11-26T13:00:00Z', end: '2026-11-26T14:00:00Z', duration_min: 60, kcal: 320, source: 'google_health' }],
    source: 'google_health', synced_at: null,
  };
  test('steps, short sleep with a no-deficit hint, workout with a protein hint', () => {
    const lines = activityLines(day, 'Asia/Almaty', 8000).join('\n');
    expect(lines).toMatch(/Шаги к \d\d:\d\d: 4\s?210 \(цель 8\s?000\), активные 180 ккал/);
    expect(lines).toContain('Сон прошлой ночи: 5 ч 00 мин (отбой 01:30, подъём 06:30), глубокий 52 мин. Мало сна — без агрессивного дефицита');
    expect(lines).toContain('Тренировка сегодня: strength_training 18:00, 60 мин, 320 ккал. После неё — белок и углеводы.');
  });
  test('nothing known → nothing said', () => {
    expect(activityLines(undefined, 'Asia/Almaty', 8000)).toEqual([]);
  });
});
