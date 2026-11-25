// Meal titles are built from what is actually in the meal (D24). The agent may suggest a
// short title, but only one without numbers that does not name food the meal does not have:
// «Fuse Tea 0,5 л (170 ккал)» on a meal of sweet potato is exactly the lie this prevents.
import { isAdj, isContent, sameStem, tokens } from '@/lib/recognition/relevance';

const MAX_TITLE = 80;
const MAX_CODE_TITLE = 120;
const SHOWN_ITEMS = 3;

/** Words that describe the occasion, not the food: allowed in any title. */
const OCCASION = /^(завтрак|обед|ужин|перекус|полдник|ланч|бранч|поздн|втор|прием|приём|еда|трапез|десерт|напит|коктейл|шейк|кафе|столов|ресторан|гост|дом|работ|универ|дорог|трениров|зал|после|перед|утр|вечер|ноч|праздни|день|рожден)/;

export type TitleItem = { name: string; brand?: string | null };

export function codeTitle(names: string[]): string {
  const uniq = [...new Set(names.map((n) => n.trim()).filter(Boolean))];
  if (!uniq.length) return 'Приём';
  const head = uniq.slice(0, SHOWN_ITEMS).join(', ');
  const title = uniq.length > SHOWN_ITEMS ? `${head} и ещё ${uniq.length - SHOWN_ITEMS}` : head;
  return title.slice(0, MAX_CODE_TITLE);
}

/** The proposed title if it has no numbers and every food word in it is in the meal; else null. */
export function acceptableTitle(proposed: string | null | undefined, items: TitleItem[]): string | null {
  const t = (proposed ?? '').replace(/\s+/g, ' ').trim();
  if (t.length < 2 || t.length > MAX_TITLE) return null;
  if (/\d/.test(t) || /ккал|kcal|калори/i.test(t)) return null;
  const pool = items.flatMap((i) => tokens(`${i.name} ${i.brand ?? ''}`));
  for (const w of tokens(t).filter(isContent)) {
    if (OCCASION.test(w) || isAdj(w)) continue;
    if (!pool.some((p) => sameStem(w, p))) return null;
  }
  return t;
}

/** Title for a meal: an acceptable proposal, else the template name, else the items themselves. */
export function mealTitle(items: TitleItem[], proposed?: string | null, template?: string | null): string {
  return acceptableTitle(proposed, items) ?? template ?? codeTitle(items.map((i) => i.name));
}
