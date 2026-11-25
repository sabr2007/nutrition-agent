import { describe, expect, test } from 'vitest';
import type { Food } from '@/lib/nutrition/types';
import { detectBrand, isDrinkQuery, mergeResults, parseQuery, relevanceGate, sameStem, simplifiedQuery } from '@/lib/recognition/relevance';
import { plausible } from '@/lib/recognition/match';

// Shapes and scores copied from production search_foods results (24.11 regression, D24).
const food = (name_ru: string, o: Partial<Food> = {}): Food => ({
  id: name_ru, user_id: null, source: 'seed', name_ru, state: 'as_is', kcal_100g: 100, protein_100g: 1, fat_100g: 1, carbs_100g: 1,
  confidence: 'high', score: 1.5, ...o,
});
const tea = food('Чай без сахара', { name_en: 'Tea, brewed', category: 'drinks', aliases: ['чай', 'чай черный', 'чай зеленый'], kcal_100g: 1, score: 0.96 });
const batat = food('Батат', { name_en: 'Sweet potato, raw', category: 'vegetables', aliases: ['батат', 'сладкий картофель'], kcal_100g: 86, score: 1.0 });
const cola = food('Кола (с сахаром)', { name_en: 'Cola, regular', category: 'drinks', aliases: ['кола', 'кока-кола', 'пепси', 'газировка'], kcal_100g: 42, score: 1.986 });
const bar = food('Шоколадный батончик (типа Snickers)', { category: 'sweets', aliases: ['сникерс', 'батончик', 'марс'], kcal_100g: 488, score: 1.2 });
const mash = food('Картофельное пюре (с молоком и маслом)', { category: 'vegetables', score: 0.667 });
const breast = food('Куриная грудка (филе), сырая', { category: 'poultry', state: 'raw', score: 1.647 });
const buckwheat = food('Гречка варёная (рассыпчатая)', { category: 'grains', state: 'cooked', score: 2.2 });
const pilafBeef = food('Плов (с говядиной/бараниной)', { category: 'dishes', score: 2.244 });
const pilafChicken = food('Плов с курицей', { category: 'dishes', score: 2.244 });
const veg = food('Овощи некрахмалистые (смесь)', { category: 'vegetables', score: 1.911 });
const egg = food('Яйцо варёное (без скорлупы)', { category: 'eggs', score: 1.711 });
const oatsWater = food('Овсянка на воде (готовая)', { category: 'grains', score: 1.869 });
const fuseMine = food('Fuse Tea', { user_id: 'me', source: 'user', brand: 'Fuse Tea', category: 'drinks', protein_100g: null, fat_100g: null, carbs_100g: null, confidence: 'user_kcal_only', score: 2.2 });

describe('sameStem', () => {
  test('matches word forms', () => {
    expect(sameStem('грудки', 'грудка')).toBe(true);
    expect(sameStem('яйца', 'яйцо')).toBe(true);
    expect(sameStem('чай', 'чая')).toBe(true);
    expect(sameStem('овощей', 'овощи')).toBe(true);
    expect(sameStem('сахаром', 'сахара')).toBe(true);
  });
  test('does not match different foods', () => {
    expect(sameStem('сыр', 'сырники')).toBe(false);
    expect(sameStem('кофе', 'картофельное')).toBe(false);
    expect(sameStem('чай', 'сладкий')).toBe(false);
    expect(sameStem('голубцы', 'голубика')).toBe(false);
    expect(sameStem('пирожок', 'пирожное')).toBe(false);
    expect(sameStem('сок', 'сом')).toBe(false);
  });
  test('inflections with consonant endings', () => {
    expect(sameStem('молоком', 'молоко')).toBe(true);
    expect(sameStem('бананов', 'банан')).toBe(true);
  });
});

describe('parseQuery', () => {
  test('core nouns skip adjectives, numbers and units', () => {
    expect(parseQuery('сладкий холодный чай сахар напиток 34 ккал 100 мл').nouns).toEqual(['чай', 'сахар', 'напиток']);
    expect(parseQuery('куриной грудки 250 г').nouns).toEqual(['грудки']);
    expect(parseQuery('Fuse Tea 0,5 л').nouns).toEqual(['fuse', 'tea']);
  });
  test('modifiers after prepositions', () => {
    expect(parseQuery('кофе с молоком').modifiers).toEqual([{ prep: 'с', word: 'молоком' }]);
    expect(parseQuery('чай без сахара').modifiers).toEqual([{ prep: 'без', word: 'сахара' }]);
  });
  test('drinks are recognized by the food itself', () => {
    expect(isDrinkQuery(parseQuery('сладкий холодный чай'))).toBe(true);
    expect(isDrinkQuery(parseQuery('кофе с молоком'))).toBe(true);
    expect(isDrinkQuery(parseQuery('чайная ложка сахара'))).toBe(false);
  });
});

describe('detectBrand', () => {
  test('Latin words, quotes and known brands', () => {
    expect(detectBrand('Fuse Tea 0,5 л')).toBe('fuse tea');
    expect(detectBrand('Coca-Cola')).toBe('coca cola');
    expect(detectBrand('кока-кола 0,33')).toBe('кока кола');
    expect(detectBrand('сникерс')).toBe('сникерс');
    expect(detectBrand('батончик «Лумо»')).toBe('лумо');
    expect(detectBrand('творог', 'Простоквашино')).toBe('простоквашино');
  });
  test('generic food has no brand', () => {
    expect(detectBrand('куриная грудка')).toBeNull();
    expect(detectBrand('протеин whey')).toBeNull();
    expect(detectBrand('гречка 50 г')).toBeNull();
  });
});

// False positives found by running the gate over production search results (D24 calibration).
const pasta = food('Макароны варёные', { category: 'grains', state: 'cooked', aliases: ['макароны варёные', 'макароны вареные', 'паста'], score: 1.34 });
const oats = food('Овсянка на воде (готовая)', { category: 'grains', aliases: ['овсяная каша', 'овсянка на воде', 'каша овсяная'], score: 1.04 });
const shashlik = food('Шашлык из куриной грудки', { category: 'dishes', aliases: ['шашлык из грудки'], score: 1.996 });
const breastAlias = food('Куриная грудка (филе), сырая', { category: 'poultry', state: 'raw', aliases: ['грудка', 'куриное филе', 'курица'], score: 1.647 });
const grapes = food('Виноград', { category: 'fruits', score: 2.8 });
const walnut = food('Грецкий орех', { category: 'nuts', aliases: ['грецкие орехи', 'орехи'], kcal_100g: 654, fat_100g: 65.2, score: 1.7 });
const colaZero = food('Кола без сахара', { name_en: 'Cola, zero sugar', category: 'drinks', aliases: ['кола зеро'], score: 1.896 });
const colaSugar = { ...cola, score: 1.896 };
const bakedBreast = food('Куриная грудка, запечённая/жареная без масла', { category: 'poultry', state: 'cooked', aliases: ['грудка запечённая'], score: 2.0 });

describe('relevanceGate calibration on production results', () => {
  test('«варенье» is not boiled pasta', () => {
    expect(relevanceGate('варенье', [pasta]).ok).toBe(false);
  });
  test('the telling adjective counts: «манная каша» is not oatmeal', () => {
    expect(relevanceGate('манная каша', [oats]).ok).toBe(false);
  });
  test('the food\'s own head word must be named: grilled skewers are not «куриной грудки»', () => {
    const g = relevanceGate('куриной грудки', [shashlik, breastAlias]);
    expect(g.ok && g.pool.map((f) => f.name_ru)).toEqual(['Куриная грудка (филе), сырая']);
  });
  test('an alias names the food: «курица» → chicken breast', () => {
    expect(relevanceGate('курица', [breastAlias]).ok).toBe(true);
  });
  test('grapes are not wine', () => {
    expect(isDrinkQuery(parseQuery('виноград'))).toBe(false);
    expect(relevanceGate('виноград', [grapes]).ok).toBe(true);
  });
  test('nuts are not blocked as a fat', () => {
    expect(plausible(walnut, 'орехи')).toBe(true);
    expect(relevanceGate('орехи', [walnut]).ok).toBe(true);
  });
  test('on a tie the plain variant wins over an unasked «без сахара»', () => {
    const g = relevanceGate('кола', [colaZero, colaSugar]);
    expect(g.ok && g.pool[0].name_ru).toBe('Кола (с сахаром)');
  });
  test('a better-scored «без масла» variant is kept first', () => {
    const g = relevanceGate('куриная грудка запечённая', [bakedBreast, { ...breastAlias, score: 1.625 }]);
    expect(g.ok && g.pool[0].name_ru).toBe('Куриная грудка, запечённая/жареная без масла');
  });
  test('retry query keeps only the food words', () => {
    expect(simplifiedQuery('2 яйца')).toBe('яйца');
    expect(simplifiedQuery('банан средний')).toBe('банан');
    expect(simplifiedQuery('куриная грудка запечённая с травами')).toBe('куриная грудка');
  });
  test('merged results keep the best score per food', () => {
    const low = { ...egg, score: 0.71 };
    expect(mergeResults([low], [egg])).toEqual([egg]);
  });
});

describe('relevanceGate (D24 regression)', () => {
  test('a brand never becomes a generic food: Fuse Tea ≠ «чай без сахара»', () => {
    const g = relevanceGate('Fuse Tea', [tea]);
    expect(g).toMatchObject({ ok: false, reason: 'brand', brand: 'fuse tea' });
  });
  test('«сладкий холодный чай…» never becomes sweet potato', () => {
    const g = relevanceGate('сладкий холодный чай сахар напиток 34 ккал 100 мл', [batat]);
    expect(g.ok).toBe(false);
  });
  test('Coca-Cola and кока-кола are not silently a generic cola', () => {
    expect(relevanceGate('Coca-Cola', [cola])).toMatchObject({ ok: false, reason: 'brand' });
    expect(relevanceGate('кока-кола', [cola])).toMatchObject({ ok: false, reason: 'brand' });
  });
  test('the person chose the generic analogue by a button', () => {
    expect(relevanceGate('кока-кола', [cola], { allowGeneric: true }).ok).toBe(true);
  });
  test('an unknown branded bar is not a Snickers', () => {
    expect(relevanceGate('батончик Lumo Crunch', [bar])).toMatchObject({ ok: false, reason: 'brand' });
  });
  test('a personal food with the brand matches', () => {
    const g = relevanceGate('Fuse Tea', [tea, fuseMine]);
    expect(g.ok && g.pool.map((f) => f.id)).toEqual(['Fuse Tea']);
  });
  test('wrong neighbours are rejected', () => {
    expect(relevanceGate('кофе с молоком', [mash]).ok).toBe(false);
    expect(relevanceGate('чай с сахаром', [tea]).ok).toBe(false);
    expect(relevanceGate('овсянка на молоке', [oatsWater]).ok).toBe(false);
  });
  test('«гречка с курицей» must be two items', () => {
    const g = relevanceGate('гречка с курицей', [buckwheat]);
    expect(g).toMatchObject({ ok: false, reason: 'weak' });
    if (!g.ok) expect(g.detail).toMatch(/отдельной позицией/);
  });
  test('good generic matches still pass', () => {
    expect(relevanceGate('куриной грудки', [breast]).ok).toBe(true);
    expect(relevanceGate('гречка варёная', [buckwheat]).ok).toBe(true);
    expect(relevanceGate('овощи', [veg]).ok).toBe(true);
    expect(relevanceGate('яйца', [egg]).ok).toBe(true);
    expect(relevanceGate('чай', [tea]).ok).toBe(true);
    expect(relevanceGate('чай без сахара', [tea]).ok).toBe(true);
    expect(relevanceGate('овсянка на воде', [oatsWater]).ok).toBe(true);
    expect(relevanceGate('гречка на ужин', [buckwheat]).ok).toBe(true);
  });
  test('modifiers choose the right variant', () => {
    const g = relevanceGate('плов с курицей', [pilafBeef, pilafChicken]);
    expect(g.ok && g.pool.map((f) => f.name_ru)).toEqual(['Плов с курицей']);
  });
  test('low search scores are weak', () => {
    expect(relevanceGate('гречка', [food('Гречка сухая', { category: 'grains', score: 0.6 })])).toMatchObject({ ok: false, reason: 'weak' });
  });
  test('no results', () => {
    expect(relevanceGate('что-то', [])).toMatchObject({ ok: false, reason: 'no_results' });
  });
});
