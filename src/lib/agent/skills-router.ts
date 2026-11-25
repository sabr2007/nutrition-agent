// Deterministic skill routing: weaker models often skip load_skill, so obvious intents
// pre-load the matching procedure into the system prompt (the model can still load others).
const RULES: { key: string; re: RegExp }[] = [
  { key: 'slip_review', re: /сорвал|срыв|переел|объел|обожрал|не удержал|бургер|фастфуд|шаурм|пицц|сладк.*много|наел/i },
  { key: 'close_day', re: /закр(ыть|ой|оем) день|итог(и)? дня|подвед(и|ём) итог|всё записано|день закончен/i },
  { key: 'whats_to_eat_now', re: /что (мне )?(съесть|поесть|покушать)|чем (до)?брать|добрать бел|осталось .*бел|не хватает бел|голоден|хочу есть/i },
  { key: 'shopping_list', re: /список покупок|что купить|закуп/i },
  { key: 'weekly_review', re: /недел[юяи]|за неделю|недельн|разбор недели|динамик/i },
  { key: 'plan_tomorrow', re: /план на завтра|завтра (как|что) (есть|питаться)|распиши завтра|на завтра план/i },
  { key: 'recipe', re: /рецепт|что приготовить|как приготовить/i },
];

export function matchSkill(text: string | undefined | null): string | null {
  if (!text) return null;
  for (const r of RULES) if (r.re.test(text)) return r.key;
  return null;
}

// Deterministic safety layer: binge-eating signals in the message (or a pattern of slips)
// force an explicit, gentle specialist suggestion — we do not rely on the model noticing.
const BINGE = /не мог(у|ла)? остановит|не контролир|потерял(а)? контроль|переедаю|обжираюсь|ночью (опять )?(объел|наел|ел)|стыдно|ненавижу себя|заедаю|компульсив|очень много за раз/i;

export function safetySignals(text: string | undefined | null, recentSlips: number): { binge: boolean; reason: string | null } {
  if (text && BINGE.test(text)) return { binge: true, reason: 'в сообщении есть признаки компульсивного переедания' };
  if (recentSlips >= 3) return { binge: true, reason: `за 14 дней записано срывов: ${recentSlips}` };
  return { binge: false, reason: null };
}

// "I ate X" reports must be logged first; weaker models sometimes answer with suggestions instead.
const FOOD_REPORT = /(^|\s)(съел[аи]?|поел[аи]?|наел(ся|ась)|выпил[аи]?|перекусил[аи]?|позавтракал[аи]?|пообедал[аи]?|поужинал[аи]?|скушал[аи]?|был[аи]? на (обеде|ужине)|на (завтрак|обед|ужин) (был|была|было|были|ел))(\s|$|[,.!])/i;

// "запиши 250 г грудки…" is a food report too: an explicit request to log, with an amount.
const LOG_REQUEST = /(^|\s)(запиши|добавь|внеси)(\s|$)/i;
const AMOUNT = /\d+([.,]\d+)?\s*(г|гр|грамм\w*|кг|мл|шт\w*)(\s|$|[,.;])/i;

export function isFoodReport(text: string | undefined | null): boolean {
  if (!text || /\?\s*$/.test(text.trim())) return false;
  return FOOD_REPORT.test(text) || (LOG_REQUEST.test(text) && AMOUNT.test(text));
}

// «исправь», «там на самом деле 250», «у тебя всё ещё висит 5 ккал»: fix the existing meal, never log a new one.
const CORRECTION = /(исправ|поправ|переправ|не то(?![а-яё])|не тот|не так записал|висит|ошибочн|неправильн|замени|удали (это|лишн|последн|ошибк)|на самом деле)/i;

export function isCorrection(text: string | undefined | null): boolean {
  return Boolean(text && CORRECTION.test(text));
}

// «там 170 ккал», «250 калорий на пачку»: the person's own numbers → save_user_food.
const STATED_KCAL = /\d+([.,]\d+)?\s*(ккал|кал(?![а-яё])|калори|kcal)/i;

export function statesCalories(text: string | undefined | null): boolean {
  return Boolean(text && STATED_KCAL.test(text));
}
