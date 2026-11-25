// Relevance gate for food matching (D24). The fuzzy search always returns *something*;
// this decides whether a hit really is the food the person named. A weak hit is never
// logged: the agent gets `needs_food` with candidates and asks, or saves the user's numbers.
//
// Rules, in order:
//  1. Brands (Latin words, «quoted» names, known brands, an explicit brand) only match
//     branded or personal foods that contain the brand — never a generic base food.
//  2. Drinks only match drinks/dairy/supplements, and drinks only match drink queries.
//  3. The search score must be high enough; every noun of the query must be a noun of the
//     food (or its aliases), every telling adjective («сладкий», «манная») must be there too,
//     the food's own head noun must be in the query («шашлык из грудки» ≠ «грудка»), a «с X»
//     part must be in the food, and the food must not say the opposite («без сахара»).
// Calibrated on production search results (docs/DECISIONS.md, D24).
import type { Food } from '@/lib/nutrition/types';

/** search_foods scores: exact ≈ 2–2.5, good ≈ 1–2, wrong neighbours ≈ 0.6–0.75. */
export const MIN_MATCH_SCORE = 0.75;

const STOP = new Set(['и', 'или', 'из', 'к', 'ко', 'от', 'до', 'за', 'для', 'по', 'типа', 'a', 'the', 'of', 'and', 'with']);
const PREPS = new Set(['с', 'со', 'без', 'на', 'в', 'во', 'под']);
/** Units and amounts: not part of what the food is. */
const UNIT = /^(г|гр|грамм\w*|кг|мг|мл|л|литр\w*|шт|штук\w*|ккал|кал|калори\w*|kcal|cal|ml|l|g|kg|mg|порци\w*|ложк\w*|стакан\w*|кус(о)?ч?к\w*|упаковк\w*|пачк\w*|банк\w*|бутылк\w*|тарелк\w*|чашк\w*|кружк\w*|мини|макси|пол|полови\w*|четверт\w*|треть|немн\w*|чуть|много|пар[аеуы]?|штучк\w*|ломтик\w*|дольк\w*|горст\w*|щепотк\w*)$/;
const NUMBER = /^\d+([.,]\d+)?%?$/;
/** Russian adjective/participle endings: descriptors, not the food itself. */
const ADJ = /(ый|ий|ой|ая|яя|ое|ее|ые|ие|ого|его|ому|ему|ую|юю|ым|им|ыми|ими|ых|их)$/;
/** Adjectives about state, size or freshness: they do not change which food it is. */
const LOOSE_ADJ = /^(сыр(ой|ая|ое|ые|ого|ую)$|варен|отварн|жарен|запечен|печен|тушен|готов|свеж|домашн|горяч|холодн|тепл|больш|средн|маленьк|мелк|крупн|вкусн|обычн|прост|натуральн|цел(ый|ая|ое|ые)$|нарезан|резан|рублен|приготовлен|разогрет|остывш|вчерашн|утренн|вечерн|ночн|магазинн|покупн|любим)/;
/** Inflection endings: «грудк|и» ≈ «грудк|а», «молок|ом» ≈ «молок|о», «tea» ≈ «tea|s». */
const ENDING = /^(|а|я|о|е|ы|и|у|ю|ь|й|ой|ей|ий|ый|ая|яя|ое|ее|ые|ие|ом|ем|ам|ям|ами|ями|ах|ях|ов|ев|ью|ия|ии|ию|ье|ья|ьи|ьев|ого|его|ому|ему|ым|им|ыми|ими|ых|их|ую|юю|s|es)$/;

/** Latin words that name generic foods or units, not brands. */
const GENERIC_LATIN = new Set(['whey', 'protein', 'isolate', 'casein', 'bcaa', 'omega', 'mct', 'kcal', 'cal', 'ml', 'g', 'kg', 'mg', 'l']);

/** Brands people write in Cyrillic (normalized). Multi-word entries match as phrases. */
const KNOWN_BRANDS = [
  'кока кола', 'кока', 'пепси', 'фанта', 'спрайт', 'фьюз', 'липтон', 'нести', 'ред булл', 'редбулл', 'адреналин', 'берн',
  'монстр', 'горилла', 'сникерс', 'марс', 'твикс', 'баунти', 'киткат', 'кит кат', 'милка', 'альпен гольд', 'рафаэлло',
  'нутелла', 'орео', 'данон', 'даниссимо', 'активиа', 'актимель', 'растишка', 'простоквашино', 'домик в деревне',
  'агуша', 'эрмигурт', 'савушкин', 'макдоналдс', 'макдак', 'бургер кинг', 'кфс', 'додо', 'старбакс', 'нескафе',
  'якобс', 'лейс', 'принглс', 'читос', 'чипсоны', 'бон аква', 'боржоми', 'добрый', 'рич', 'джей севен', 'фрутоняня',
  'чудо', 'фуд мастер', 'лактель', 'бахус', 'шин рамен', 'доширак', 'роллтон', 'биг бон',
];

const DRINK = /^(чай|чая|чаю|чаем|кофе|сок|сока|соку|соки|соком|напит\w*|кол[аыуе]|колой|газиров\w*|лимонад\w*|вод[аыуе]|водой|морс\w*|компот\w*|квас\w*|пив[оау]|пивом|вин[оау]|вином|шампанск\w*|коньяк\w*|водк[аиуе]|виски|сидр\w*|энергетик\w*|смузи|коктейл\w*|латте|капучино|американо|эспрессо|какао|айран\w*|кефир\w*|молок[оау]|молоком|ряженк\w*|тан|кумыс\w*|шубат\w*|матча|улун|пуэр|каркаде|минералк\w*|tea|teas|coffee|juice|cola|soda|drink|water|beer|wine|latte|cappuccino|lemonade)$/;
const DRINK_CATEGORIES = new Set(['drinks', 'dairy', 'supplements']);

export function tokens(s: string | null | undefined): string[] {
  return (s ?? '').toLowerCase().replace(/ё/g, 'е').replace(/[^\p{L}\p{N}%.,]+/gu, ' ').replace(/(?<!\d)[.,]|[.,](?!\d)/g, ' ')
    .trim().split(/\s+/).filter(Boolean);
}

const isLatin = (w: string) => /^[a-z][a-z'-]*$/.test(w);
export const isContent = (w: string): boolean => !STOP.has(w) && !PREPS.has(w) && !UNIT.test(w) && !NUMBER.test(w) && w.length > 1;
export const isAdj = (w: string): boolean => !isLatin(w) && w.length > 3 && ADJ.test(w);

/** Same word up to an inflection ending: «грудки» ≈ «грудка», «чай» ≈ «чая»; «варенье» ≠ «вареные». */
export function sameStem(a: string, b: string): boolean {
  if (a === b) return true;
  const n = Math.min(a.length, b.length);
  let common = 0;
  while (common < n && a[common] === b[common]) common++;
  const minStem = n <= 3 ? 2 : 3;
  for (let k = common; k >= minStem; k--) if (ENDING.test(a.slice(k)) && ENDING.test(b.slice(k))) return true;
  return false;
}

const covered = (word: string, pool: string[]) => pool.some((p) => sameStem(word, p));

export type ParsedQuery = {
  /** Content words before the first preposition: the food itself («куриная грудка»). */
  core: string[];
  /** Nouns of the core: each must be a noun of the matched food. */
  nouns: string[];
  /** Telling adjectives of the core («сладкий», «манная»): each must be in the food. */
  adjectives: string[];
  /** «с курицей», «без сахара», «на молоке» → [prep, noun]. */
  modifiers: { prep: string; word: string }[];
};

export function parseQuery(q: string | null | undefined): ParsedQuery {
  const core: string[] = [];
  const modifiers: ParsedQuery['modifiers'] = [];
  let prep: string | null = null;
  for (const w of tokens(q)) {
    if (PREPS.has(w)) { prep = w === 'со' ? 'с' : w === 'во' ? 'в' : w; continue; }
    if (!isContent(w)) continue;
    if (prep) { if (!isAdj(w)) modifiers.push({ prep, word: w }); continue; }
    core.push(w);
  }
  const nouns = core.filter((w) => !isAdj(w));
  return {
    core,
    nouns: nouns.length ? nouns : core.slice(-1),
    adjectives: nouns.length ? core.filter((w) => isAdj(w) && !LOOSE_ADJ.test(w)) : [],
    modifiers,
  };
}

/** The query without amounts, loose descriptors and «с X» parts: «2 яйца» → «яйца». */
export function simplifiedQuery(q: string): string {
  const p = parseQuery(q);
  return p.core.filter((w) => !isAdj(w) || !LOOSE_ADJ.test(w)).join(' ');
}

type BrandHit = { brand: string; via: 'explicit' | 'quoted' | 'latin' | 'known' };

function brandOf(query: string | null | undefined, explicit?: string | null): BrandHit | null {
  const given = tokens(explicit).filter(isContent).join(' ');
  if (given) return { brand: given, via: 'explicit' };
  const q = query ?? '';
  const quoted = q.match(/[«"“„]([^»"”]{2,60})[»"”]/);
  if (quoted) {
    const inner = tokens(quoted[1]).filter(isContent).join(' ');
    if (inner) return { brand: inner, via: 'quoted' };
  }
  const all = tokens(q);
  const latin = all.filter((w) => isLatin(w) && w.length > 1 && !GENERIC_LATIN.has(w));
  if (latin.length) return { brand: latin.join(' '), via: 'latin' };
  const padded = ` ${all.join(' ')} `;
  for (const b of KNOWN_BRANDS) {
    if (b.includes(' ') ? padded.includes(` ${b} `) : all.some((w) => w.startsWith(b) && w.length - b.length <= 2)) return { brand: b, via: 'known' };
  }
  return null;
}

/** The brand named in a query, if any (normalized), or null for generic food. */
export function detectBrand(query: string | null | undefined, explicit?: string | null): string | null {
  return brandOf(query, explicit)?.brand ?? null;
}

/** A shared base food with no brand: "чай без сахара", not "Fuse Tea". */
export function isGeneric(f: Pick<Food, 'user_id' | 'brand'>): boolean {
  return !f.user_id && !f.brand;
}

function foodText(f: Food): string {
  return [f.name_ru, f.name_en, f.brand, ...(f.aliases ?? [])].filter(Boolean).join(' ');
}

const contentOf = (s: string | null | undefined) => tokens(s).filter(isContent);

export function isDrinkQuery(p: ParsedQuery): boolean {
  return p.nouns.some((w) => DRINK.test(w));
}

export function categoryCompatible(f: Pick<Food, 'category'>, drinkQuery: boolean): boolean {
  if (!f.category) return true;
  return drinkQuery ? DRINK_CATEGORIES.has(f.category) : f.category !== 'drinks';
}

/** Does the food contain the brand words? */
export function coversBrand(f: Food, brand: string): boolean {
  const words = contentOf(foodText(f));
  return contentOf(brand).every((w) => covered(w, words));
}

/** «с X», «под X», «на X» add food (sauce, oil, milk) unless X is a cooking method or a time of day. */
const ADDS_FOOD = new Set(['с', 'под', 'на']);
const NEUTRAL_MODIFIER = /^(завтрак|обед|ужин|перекус|полдник|ноч|работ|пар[уа]|грил|мангал|угл|сковород|огн|костр|вынос|ход[уы]|тарелк|пикник)/;

/** Product-type nouns: a branded product's page may leave them out («Ромашка» for «конфеты Ромашка»). */
const CATEGORY_NOUN = /^(конфет|шоколад|батончик|вафл|печень|пряник|зефир|мармелад|пастил|торт|пирожн|напит|чай|кофе|сок|вод|газировк|лимонад|морс|кефир|йогурт|сырок|сырк|мороже|снек|чипс|сухар|крекер|хлоп|мюсли|каш|соус|паст)/;

const FLAVOR = /^(лимон|персик|клубни|малин|вишн|мят|ванил|яблоч|апельсин|манго|банан|карамел|кокос|черни|смородин|груш|ананас|арбуз|дын|лайм|грейпфрут|киви|клюкв|брусни|облепих|имбир|земляни)/;

/**
 * A branded product found by its brand may omit the category («конфеты») and descriptors
 * («глазированные») — as long as the product's own name is there and the food adds no words of
 * its own («Вафли Ромашка» is another product than «конфеты Ромашка»).
 */
function brandedProblem(p: ParsedQuery, f: Food, lost: string[], brandWords: string[]): string | null {
  // A flavor is part of the product's identity («лимонный» Fuse Tea is not the peach one).
  const named = lost.filter((w) => FLAVOR.test(w) || (!isAdj(w) && !CATEGORY_NOUN.test(w)));
  if (named.length) return `нет «${named.join(', ')}» в «${f.name_ru}»`;
  const queryWords = [...p.nouns, ...p.adjectives, ...p.core, ...p.modifiers.map((m) => m.word)];
  const extra = contentOf(f.name_ru).filter((w) => !covered(w, queryWords) && !brandWords.some((b) => sameStem(w, b)));
  return extra.length ? `«${f.name_ru}» — ещё «${extra.join(' ')}»` : null;
}

/** Why a food does not fit the parsed query, or null when it fits. */
export function relevanceProblem(p: ParsedQuery, f: Food, opts: { brandMatched?: boolean; brandWords?: string[] } = {}): string | null {
  const all = contentOf(foodText(f));
  const nouns = all.filter((w) => !isAdj(w));
  const missing = p.nouns.filter((w) => !covered(w, isAdj(w) ? all : nouns));
  const lostTrait = p.adjectives.filter((w) => !covered(w, all));
  if (opts.brandMatched && (missing.length || lostTrait.length)) {
    const why = brandedProblem(p, f, [...missing, ...lostTrait], opts.brandWords ?? []);
    if (why) return why;
  } else {
    if (missing.length) return `нет «${missing.join(', ')}» в «${f.name_ru}»`;
    if (lostTrait.length) return `«${f.name_ru}» — не «${lostTrait.join(' ')}»`;
  }
  if (!opts.brandMatched) {
    // The food's own main word must be in the query, or one of its aliases must be fully named.
    const queryWords = [...p.core, ...p.modifiers.map((m) => m.word)];
    const head = parseQuery(f.name_ru).nouns[0];
    const aliasNamed = (f.aliases ?? []).some((a) => { const w = contentOf(a); return w.length > 0 && w.every((x) => covered(x, queryWords)); });
    if (head && !covered(head, queryWords) && !aliasNamed) return `«${f.name_ru}» — другое блюдо`;
  }
  const fm = parseQuery(f.name_ru).modifiers;
  for (const m of p.modifiers) {
    const opposite = fm.find((x) => sameStem(m.word, x.word) && ((m.prep === 'с' && x.prep === 'без') || (m.prep === 'без' && x.prep === 'с')));
    if (opposite) return `«${m.prep} ${m.word}» против «${opposite.prep} ${opposite.word}» в «${f.name_ru}»`;
    if (m.prep === 'без' || NEUTRAL_MODIFIER.test(m.word)) continue;
    const samePrep = fm.filter((x) => x.prep === m.prep);
    if (samePrep.length && !samePrep.some((x) => sameStem(x.word, m.word))) return `«${m.prep} ${m.word}» против «${m.prep} ${samePrep[0].word}» в «${f.name_ru}»`;
    if (ADDS_FOOD.has(m.prep) && !covered(m.word, all)) return `«${m.prep} ${m.word}» нет в «${f.name_ru}» — запиши отдельной позицией`;
  }
  return null;
}

/** A «без X» variant the person did not ask for (cola without sugar for «кола»). */
function unaskedWithout(p: ParsedQuery, f: Food): boolean {
  return parseQuery(f.name_ru).modifiers.some((x) => x.prep === 'без' && !p.modifiers.some((m) => sameStem(m.word, x.word)));
}

export type NeedsFoodReason = 'no_results' | 'brand' | 'category' | 'weak' | 'unknown_food_id';

export type MatchGate =
  | { ok: true; pool: Food[]; brand: string | null }
  | { ok: false; reason: NeedsFoodReason; brand: string | null; detail: string | null };

/**
 * Filters search results down to foods that really are what the query names, best first.
 * `allowGeneric` — the person agreed (by a button) to log a branded product as a generic analogue.
 */
export function relevanceGate(query: string, results: Food[], opts: { brand?: string | null; allowGeneric?: boolean } = {}): MatchGate {
  let hit = brandOf(query, opts.brand);
  // A Latin word that is the English name of a generic food («marshmallow») is not a brand.
  if (hit?.via === 'latin' && results.some((f) => isGeneric(f) && f.name_en && contentOf(hit!.brand).every((w) => covered(w, contentOf(f.name_en))))) hit = null;
  const brand = hit?.brand ?? null;
  if (!results.length) return { ok: false, reason: 'no_results', brand, detail: null };
  const parsed = parseQuery(query);
  let pool = results;
  const brandMatched = Boolean(brand && !opts.allowGeneric);
  if (brandMatched) {
    pool = pool.filter((f) => !isGeneric(f) && coversBrand(f, brand!));
    if (!pool.length) return { ok: false, reason: 'brand', brand, detail: `«${brand}» — бренд, общий продукт не подставляю` };
  }
  // Brand words are checked above (or waived by the person's choice of a generic analogue);
  // the rest of the core («холодный чай») must fit too.
  const brandWords = brand ? contentOf(brand) : [];
  const strip = (ws: string[]) => ws.filter((w) => !brandWords.some((b) => sameStem(w, b)));
  const target: ParsedQuery = brand ? { ...parsed, nouns: strip(parsed.nouns), adjectives: strip(parsed.adjectives) } : parsed;
  const drink = isDrinkQuery(parsed);
  const byCategory = pool.filter((f) => categoryCompatible(f, drink));
  if (!byCategory.length) return { ok: false, reason: 'category', brand, detail: drink ? 'запрос про напиток, а нашёлся не напиток' : 'нашёлся напиток, а запрос не про напиток' };
  const problems: string[] = [];
  const fit = byCategory.filter((f) => {
    if ((f.score ?? 1) < MIN_MATCH_SCORE) { problems.push(`слабое совпадение «${f.name_ru}»`); return false; }
    const why = relevanceProblem(target, f, { brandMatched, brandWords });
    if (why) problems.push(why);
    return !why;
  });
  if (!fit.length) return { ok: false, reason: 'weak', brand, detail: problems[0] ?? null };
  // Best score first; on a tie the plain variant wins over an unasked «без X» one (cola > cola zero).
  const rank = (f: Food) => (f.score ?? 1) - (unaskedWithout(target, f) ? 0.01 : 0);
  return { ok: true, pool: [...fit].sort((a, b) => rank(b) - rank(a)), brand };
}

/** Two search result lists as one, keeping each food once with its best score. */
export function mergeResults(a: Food[], b: Food[]): Food[] {
  const best = new Map<string, Food>();
  for (const f of [...a, ...b]) {
    const prev = best.get(f.id);
    if (!prev || (f.score ?? 0) > (prev.score ?? 0)) best.set(f.id, f);
  }
  return [...best.values()].sort((x, y) => (y.score ?? 0) - (x.score ?? 0));
}
