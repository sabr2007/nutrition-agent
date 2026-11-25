import { describe, expect, test } from 'vitest';
import { acceptableTitle, codeTitle, mealTitle } from '@/lib/agent/meal-title';
import { isCorrection, statesCalories } from '@/lib/agent/skills-router';

describe('meal titles come from the items (D24)', () => {
  test('a title with numbers or a food that is not in the meal is replaced', () => {
    expect(mealTitle([{ name: 'Батат' }], 'Fuse Tea 0,5 л (170 ккал)')).toBe('Батат');
    expect(mealTitle([{ name: 'Куриная грудка' }], 'Ужин: батат')).toBe('Куриная грудка');
  });
  test('a matching or occasion title is kept', () => {
    expect(mealTitle([{ name: 'Fuse Tea', brand: 'Fuse Tea' }], 'Fuse Tea')).toBe('Fuse Tea');
    expect(mealTitle([{ name: 'Гречка варёная' }, { name: 'Куриная грудка' }], 'Обед')).toBe('Обед');
    expect(mealTitle([{ name: 'Кола (с сахаром)' }], 'Кола')).toBe('Кола');
  });
  test('template name when nothing is proposed', () => {
    expect(mealTitle([{ name: 'Овсянка' }], null, 'Завтрак по плану')).toBe('Завтрак по плану');
  });
  test('code title lists the items', () => {
    expect(codeTitle(['a', 'b', 'b', 'c', 'd', 'e'])).toBe('a, b, c и ещё 2');
    expect(codeTitle([])).toBe('Приём');
  });
  test('acceptableTitle rejects kcal and digits', () => {
    expect(acceptableTitle('Чай 170', [{ name: 'Чай' }])).toBeNull();
    expect(acceptableTitle('Чай, калорийный', [{ name: 'Чай' }])).toBeNull();
    expect(acceptableTitle('Чай крепкий', [{ name: 'Чай' }])).toBe('Чай крепкий');
  });
});

describe('intents', () => {
  test('corrections', () => {
    expect(isCorrection('исправь, там 250 ккал')).toBe(true);
    expect(isCorrection('Запиши 170 калорий у тебя все еще висит 5ккал')).toBe(true);
    expect(isCorrection('запиши 250 г грудки')).toBe(false);
  });
  test('stated calories', () => {
    expect(statesCalories('Fuse Tea 0,5 л, там 170 ккал')).toBe(true);
    expect(statesCalories('Там 170 калорий')).toBe(true);
    expect(statesCalories('170 кал')).toBe(true);
    expect(statesCalories('съел 2 калача')).toBe(false);
  });
});
