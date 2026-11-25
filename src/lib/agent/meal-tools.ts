import 'server-only';
import { tool, type ToolSet } from 'ai';
import { z } from 'zod';
import { listTemplates, saveMeal } from '@/lib/data/meals';
import { saveUserFood, userFoodRow } from '@/lib/data/foods';
import { todayFor } from '@/lib/data/profile';
import { instantForLocal } from '@/lib/nutrition/day';
import { macrosFor, per100Of, r1 } from '@/lib/nutrition/calc';
import type { Food, Per100 } from '@/lib/nutrition/types';
import { UserFoodError, userFoodNumbers } from '@/lib/nutrition/user-food';
import { pickBest, plausible, searchFoodsSmart } from '@/lib/recognition/match';
import { detectBrand, isGeneric, parseQuery, relevanceGate, relevanceProblem, mergeResults, simplifiedQuery, tokens, type NeedsFoodReason } from '@/lib/recognition/relevance';
import { personalContext } from '@/lib/recognition/pipeline';
import { acceptableTitle, mealTitle } from './meal-title';
import { currentDryMeal, mealTotals, type DryMeal, type DryMealItem } from './dry-world';
import type { PendingAction, ToolCtx } from './tool-ctx';
import { fatWarningFor } from './fat-warning';

// Meal-writing tools (D24): log_meal never logs a food that is not what the person named —
// weak matches come back as `needs_food`; save_user_food turns the person's own numbers into
// a food; edit_meal swaps items and reports what is really in the database afterwards.

/** The agent may undo its own recent mistake without a confirmation button. */
export const OWN_UNDO_WINDOW_MS = 30 * 60_000;
const SEARCH_LIMIT = 8;
const CANDIDATES_SHOWN = 3;

export const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('YYYY-MM-DD local day; default today');
export const hhmm = z.string().regex(/^\d{1,2}:\d{2}$/);
const slotSchema = z.enum(['breakfast', 'lunch', 'dinner', 'snack', 'shake', 'supplement', 'late']);

const NEEDS_HINT = 'Ничего не записано: эти позиции не нашлись точно. Не подставляй похожий продукт. '
  + 'Человек назвал калорийность или БЖУ — save_user_food с его цифрами, затем log_meal с food_id. '
  + 'В candidates есть ровно то, что он назвал, — log_meal с этим food_id. '
  + 'Иначе спроси кнопками (ask_user): варианты из candidates, «Скажу калорийность», «Сфоткаю этикетку». '
  + 'Общий аналог для бренда — только если он выбрал его кнопкой (allow_generic: true). Позиции из resolved передай снова по food_id.';

const ItemIn = z.object({
  food_id: z.string().uuid().optional(),
  query: z.string().max(120).optional().describe('Short food name as in the database: «гречка варёная», «куриная грудка». One food per item: «гречка с курицей» = two items'),
  brand: z.string().max(80).optional().describe('Brand or packaged product name if any: Fuse Tea, Coca-Cola, «Простоквашино»'),
  allow_generic: z.boolean().optional().describe('true only after the person chose (by a button) to log a branded product as the generic analogue'),
  grams: z.number().positive().max(5000).optional(),
  count: z.number().positive().max(50).optional(),
  state: z.enum(['raw', 'cooked', 'dry', 'as_is']).optional(),
});
type ItemInput = z.infer<typeof ItemIn>;

type Candidate = { food_id: string; name: string; brand: string | null; kcal_100g: number; generic: boolean };
type Need = { query: string; reason: NeedsFoodReason; detail: string | null; brand: string | null; candidates: Candidate[] };
type Resolved = { food: Food; grams: number; fromTemplate?: boolean };

type MealItemNow = { food_id: string | null; name: string; grams: number; per100: Per100 | null; brand?: string | null };
type MealNow = {
  id: string; root_id: string; title: string | null; slot: string | null; eaten_at: string; local_day: string;
  items: MealItemNow[];
  /** Logged by the agent within the undo window: can be deleted without a button. */
  recentOwn: boolean;
};

const candidate = (f: Food): Candidate => ({ food_id: f.id, name: f.name_ru, brand: f.brand ?? null, kcal_100g: Number(f.kcal_100g), generic: isGeneric(f) });
const itemLine = (i: { name: string; grams: number; kcal: number }) => `${i.name} ${r1(i.grams)} г — ${Math.round(i.kcal)} ккал`;

function gramsFor(food: Food, it: Pick<ItemInput, 'grams' | 'count'>): number {
  if (it.grams) return it.grams;
  if (it.count) return (food.portions?.[0]?.g ?? Number(food.default_portion_g ?? 100)) * it.count;
  return Number(food.default_portion_g ?? 100);
}

function dryItem(food: Food, grams: number): DryMealItem {
  const p = per100Of(food);
  return { food_id: food.id, name: food.name_ru, grams: r1(grams), ...macrosFor(grams, p), partial: Boolean(p.partial) };
}

async function loadFood(ctx: ToolCtx, id: string): Promise<Food | null> {
  const simulated = ctx.dry?.foods.get(id);
  if (simulated) return simulated;
  const { data } = await ctx.sb.from('foods').select('*').eq('id', id).is('archived_at', null).maybeSingle();
  return (data as Food | null) ?? null;
}

/** Database search plus foods saved earlier in this dry run. */
async function searchFor(ctx: ToolCtx, query: string): Promise<Food[]> {
  const found = await searchFoodsSmart(ctx.sb, query, SEARCH_LIMIT);
  if (!ctx.dry?.foods.size) return found;
  const parsed = parseQuery(query);
  const simulated = [...ctx.dry.foods.values()].filter((f) => !relevanceProblem(parsed, f)).map((f) => ({ ...f, score: 2.2 }));
  return [...simulated, ...found];
}

async function resolveItem(ctx: ToolCtx, it: ItemInput, preferred?: Map<string, number>): Promise<{ ok: true; r: Resolved } | { ok: false; need: Need }> {
  if (it.food_id) {
    const food = await loadFood(ctx, it.food_id);
    if (!food) return { ok: false, need: { query: it.food_id, reason: 'unknown_food_id', detail: 'такого food_id нет: возьми id из search_foods или save_user_food', brand: null, candidates: [] } };
    const brand = it.brand ? detectBrand(null, it.brand) : null;
    if (brand && isGeneric(food) && !it.allow_generic) {
      return { ok: false, need: { query: it.brand!, reason: 'brand', detail: `«${food.name_ru}» — общий продукт, а назван бренд «${it.brand}»`, brand, candidates: [candidate(food)] } };
    }
    return { ok: true, r: { food, grams: gramsFor(food, it) } };
  }
  const query = it.query?.trim();
  if (!query) return { ok: false, need: { query: '?', reason: 'no_results', detail: 'нужен food_id или query', brand: null, candidates: [] } };
  let results = (await searchFor(ctx, query)).filter((f) => plausible(f, query));
  let gate = relevanceGate(query, results, { brand: it.brand, allowGeneric: it.allow_generic });
  // «банан средний», «2 яйца»: the search ranks extra words; retry with the food words only,
  // still judged against the full query (so «с курицей» or a brand keep counting).
  const simpler = simplifiedQuery(query);
  if (!gate.ok && gate.reason !== 'brand' && simpler && simpler !== tokens(query).join(' ')) {
    const more = (await searchFor(ctx, simpler)).filter((f) => plausible(f, query));
    if (more.length) {
      results = mergeResults(results, more);
      gate = relevanceGate(query, results, { brand: it.brand, allowGeneric: it.allow_generic });
    }
  }
  if (!gate.ok) return { ok: false, need: { query, reason: gate.reason, detail: gate.detail, brand: gate.brand, candidates: results.slice(0, CANDIDATES_SHOWN).map(candidate) } };
  const best = pickBest(gate.pool, it.state, preferred, query);
  if (!best) return { ok: false, need: { query, reason: 'weak', detail: null, brand: gate.brand, candidates: results.slice(0, CANDIDATES_SHOWN).map(candidate) } };
  return { ok: true, r: { food: best.food, grams: gramsFor(best.food, it) } };
}

function fromDry(m: DryMeal): MealNow {
  return {
    id: m.id, root_id: m.root_id, title: m.title, slot: m.slot, eaten_at: m.eaten_at, local_day: m.eaten_at.slice(0, 10),
    items: m.items.map((i) => ({
      food_id: i.food_id, name: i.name, grams: i.grams,
      per100: i.grams > 0 ? { kcal: (i.kcal * 100) / i.grams, protein: (i.protein_g * 100) / i.grams, fat: (i.fat_g * 100) / i.grams, carbs: (i.carbs_g * 100) / i.grams, ...(i.partial ? { partial: true } : {}) } : null,
    })),
    recentOwn: m.by_agent && Date.now() - Date.parse(m.created_at) < OWN_UNDO_WINDOW_MS,
  };
}

/** The current version of a meal (any version id works); null if missing or deleted. */
async function loadMeal(ctx: ToolCtx, id: string): Promise<MealNow | null> {
  if (ctx.dry) {
    const simulated = currentDryMeal(ctx.dry, id);
    if (simulated) return simulated.status === 'confirmed' ? fromDry(simulated) : null;
  }
  const cols = 'id, root_id, is_current, status, title, slot, eaten_at, local_day';
  const { data: m } = await ctx.sb.from('meals').select(cols).eq('id', id).eq('user_id', ctx.userId).maybeSingle();
  if (!m) return null;
  let cur = m;
  if (!m.is_current) {
    const { data: c } = await ctx.sb.from('meals').select(cols).eq('root_id', m.root_id).eq('user_id', ctx.userId).eq('is_current', true).maybeSingle();
    if (!c) return null;
    cur = c;
  }
  if (cur.status !== 'confirmed') return null;
  const [{ data: items }, { data: root }] = await Promise.all([
    ctx.sb.from('meal_items').select('food_id, name, grams, per100, sort_order').eq('meal_id', cur.id).order('sort_order'),
    ctx.sb.from('meals').select('client_id, created_at').eq('id', cur.root_id).maybeSingle(),
  ]);
  const own = String(root?.client_id ?? '').startsWith('agent:');
  return {
    id: cur.id as string, root_id: cur.root_id as string, title: (cur.title as string) ?? null, slot: (cur.slot as string) ?? null,
    eaten_at: cur.eaten_at as string, local_day: cur.local_day as string,
    items: (items ?? []).map((i) => ({ food_id: (i.food_id as string) ?? null, name: i.name as string, grams: Number(i.grams), per100: (i.per100 as Per100) ?? null })),
    recentOwn: own && Date.now() - Date.parse(String(root?.created_at ?? 0)) < OWN_UNDO_WINDOW_MS,
  };
}

/** A real meal edited in a dry run is copied into the simulated world first. */
function adoptIntoDry(ctx: ToolCtx, m: MealNow): DryMeal {
  const existing = ctx.dry!.meals.get(m.id);
  if (existing) return existing;
  const copy: DryMeal = {
    id: m.id, root_id: m.root_id, title: m.title ?? '', slot: m.slot, eaten_at: m.eaten_at,
    created_at: m.recentOwn ? new Date().toISOString() : new Date(0).toISOString(), by_agent: m.recentOwn,
    status: 'confirmed', is_current: true,
    items: m.items.map((i) => ({ food_id: i.food_id, name: i.name, grams: i.grams, ...(i.per100 ? macrosFor(i.grams, i.per100) : { kcal: 0, protein_g: 0, fat_g: 0, carbs_g: 0 }), partial: Boolean(i.per100?.partial) })),
  };
  ctx.dry!.meals.set(copy.id, copy);
  return copy;
}

function readBack(m: { id: string; title: string; items: DryMealItem[] }) {
  const t = mealTotals(m.items);
  return {
    meal_id: m.id, title: m.title, kcal: Math.round(t.kcal), protein_g: r1(t.protein_g), fat_g: r1(t.fat_g), carbs_g: r1(t.carbs_g),
    items: m.items.map(itemLine),
    macros_incomplete: m.items.filter((i) => i.partial).map((i) => i.name),
  };
}

/** Index of the item a replace op means: «2», or a word of its name. */
function findItem(items: MealItemNow[], ref: string): number {
  const n = Number(ref.trim());
  if (Number.isInteger(n) && n >= 1 && n <= items.length) return n - 1;
  const want = ref.toLowerCase().replace(/ё/g, 'е').trim();
  return items.findIndex((i) => i.name.toLowerCase().replace(/ё/g, 'е').includes(want) || want.includes(i.name.toLowerCase().replace(/ё/g, 'е')));
}

export function mealTools(ctx: ToolCtx): ToolSet {
  const { sb, userId } = ctx;
  const dayOf = (date?: string) => date ?? todayFor(ctx.profile);

  return {
    log_meal: tool({
      description: 'Log eaten food. Each item: food_id (from search_foods / save_user_food) OR query (one food), plus grams or count; pass brand for packaged/branded products. Macros are computed by the database, never by you. If an item is not found exactly, NOTHING is logged and you get status needs_food with candidates. template_key logs a template. Title is built from the items; you may pass a short title without numbers.',
      inputSchema: z.object({
        items: z.array(ItemIn).max(20).optional(),
        template_key: z.string().optional(),
        time_local: hhmm.optional().describe('HH:MM local time it was eaten; default now'),
        date: dateSchema,
        slot: slotSchema.optional(),
        title: z.string().max(80).optional().describe('Optional, no numbers: «Обед», «Fuse Tea»'),
        note: z.string().max(300).optional(),
      }),
      execute: async (args) => {
        const day = dayOf(args.date);
        const eatenAt = args.time_local ? instantForLocal(day, args.time_local.padStart(5, '0'), ctx.profile.timezone, ctx.profile.day_boundary_minutes) : new Date();
        const resolved: Resolved[] = [];
        let template: { id: string; name: string; slot: string; checklist_key: string | null } | null = null;
        if (args.template_key) {
          const t = (await listTemplates(sb, userId)).find((x) => x.key === args.template_key || x.name === args.template_key);
          if (!t) return { error: `template not found: ${args.template_key}` };
          template = { id: t.id, name: t.name, slot: t.slot, checklist_key: t.checklist_key };
          resolved.push(...t.items.map((i) => ({ food: i.foods, grams: Number(i.grams), fromTemplate: true })));
        }
        const pc = args.items?.some((i) => i.query) ? await personalContext(sb, userId) : null;
        const needs: Need[] = [];
        for (const it of args.items ?? []) {
          const res = await resolveItem(ctx, it, pc?.preferred);
          if (res.ok) resolved.push(res.r);
          else needs.push(res.need);
        }
        if (needs.length) {
          return { status: 'needs_food', saved: false, needs, resolved: resolved.filter((r) => !r.fromTemplate).map((r) => ({ food_id: r.food.id, name: r.food.name_ru, grams: r1(r.grams) })), hint: NEEDS_HINT };
        }
        if (!resolved.length) return { error: 'nothing to log' };
        const title = mealTitle(resolved.map((r) => ({ name: r.food.name_ru, brand: r.food.brand })), args.title, template?.name ?? null);
        const slot = args.slot ?? template?.slot ?? null;
        const partial = resolved.filter((r) => per100Of(r.food).partial).map((r) => r.food.name_ru);

        if (ctx.dry) {
          const id = crypto.randomUUID();
          const meal: DryMeal = { id, root_id: id, title, slot, eaten_at: eatenAt.toISOString(), created_at: new Date().toISOString(), by_agent: true, status: 'confirmed', is_current: true, items: resolved.map((r) => dryItem(r.food, r.grams)) };
          ctx.dry.meals.set(id, meal);
          const back = readBack(meal);
          ctx.dry.effects.push({ kind: 'log', meal_id: id, title, kcal: back.kcal, grams: r1(meal.items.reduce((g, i) => g + i.grams, 0)) });
          ctx.ui.loggedMeals.push({ id, title, kcal: back.kcal, protein_g: back.protein_g, fat_g: back.fat_g, carbs_g: back.carbs_g });
          const fat = await fatWarningFor(ctx, { id, day, fat_g: back.fat_g, items: meal.items.map((i) => ({ name: i.name, grams: i.grams, kcal: i.kcal, protein_g: i.protein_g, fat_g: i.fat_g })) });
          return { saved: true, dry_run: true, ...back, fat_warning: fat };
        }

        // Honest uncertainty for the reply: kcal range from composite dishes, low-confidence items.
        const range = resolved.reduce((a, r) => {
          const mid = (Number(r.food.kcal_100g) * r.grams) / 100;
          return [a[0] + (r.food.kcal_low_100g != null ? (Number(r.food.kcal_low_100g) * r.grams) / 100 : mid), a[1] + (r.food.kcal_high_100g != null ? (Number(r.food.kcal_high_100g) * r.grams) / 100 : mid)];
        }, [0, 0]);
        const lowConfidence = resolved.filter((r) => r.food.confidence === 'low').map((r) => r.food.name_ru);
        const items = resolved.map((r) => ({ food_id: r.food.id, name: r.food.name_ru, grams: r1(r.grams), source: r.fromTemplate ? 'template' as const : 'agent' as const }));
        const fromPhoto = !template && Boolean(ctx.photo?.mediaIds.length);
        const recognitionId = fromPhoto ? await photoRecognition(ctx, items.map((i) => ({ name: i.name, grams: i.grams }))) : null;
        const saved = await saveMeal(sb, userId, {
          eaten_at: eatenAt.toISOString(), slot, title,
          input_method: template ? 'template' : fromPhoto ? 'photo' : 'agent', template_id: template?.id ?? null, note: args.note ?? null,
          recognition_id: recognitionId,
          client_id: `agent:${ctx.runId}:${JSON.stringify(items).length}:${items.map((i) => i.food_id.slice(0, 4) + i.grams).join('')}`.slice(0, 80),
          items,
        }, { checklistKey: template?.checklist_key ?? null });
        ctx.ui.loggedMeals.push({ id: saved.id, title, kcal: Math.round(saved.kcal), protein_g: saved.protein_g, fat_g: saved.fat_g, carbs_g: saved.carbs_g });
        const fat = await fatWarningFor(ctx, {
          id: saved.id, day: saved.local_day, fat_g: saved.fat_g,
          items: resolved.map((r) => { const m = macrosFor(r.grams, per100Of(r.food)); return { name: r.food.name_ru, grams: r.grams, kcal: m.kcal, protein_g: m.protein_g, fat_g: m.fat_g }; }),
        }).catch(() => null);
        return {
          fat_warning: fat,
          saved: true, meal_id: saved.id, title, day: saved.local_day, kcal: Math.round(saved.kcal), protein_g: saved.protein_g, fat_g: saved.fat_g, carbs_g: saved.carbs_g,
          kcal_range: range[1] - range[0] > 40 ? [Math.round(range[0]), Math.round(range[1])] : null,
          low_confidence_items: lowConfidence,
          macros_incomplete: partial,
          note_for_reply: lowConfidence.length ? 'Оценка примерная: назови диапазон ккал и предложи уточнить граммы кнопками.'
            : partial.length ? `У «${partial.join('», «')}» известны только калории: БЖУ не учтены, скажи об этом.` : null,
          items: resolved.map((r) => `${r.food.name_ru} ${r1(r.grams)}г`), checklist_marked: saved.checklist,
        };
      },
    }),

    save_user_food: tool({
      description: 'Create (or reuse) a food from numbers the PERSON stated («там 170 ккал»), read from a label, or found on a web page (origin web + source_ref URL). Numbers refer to `amount` of `unit`: «0,5 л — 170 ккал» → kcal 170, amount 500, unit ml. Code converts to per 100 g (1 ml = 1 g) and checks them; kcal alone is fine (macros stay unknown). Returns food_id for log_meal or edit_meal. Never invent or recall numbers yourself.',
      inputSchema: z.object({
        name: z.string().min(2).max(120).describe('Product name without numbers: «Fuse Tea лимон»'),
        brand: z.string().max(80).optional(),
        kcal: z.number().min(0).max(5000),
        protein: z.number().min(0).max(500).optional(),
        fat: z.number().min(0).max(500).optional(),
        carbs: z.number().min(0).max(500).optional(),
        amount: z.number().positive().max(5000).describe('How much the numbers refer to'),
        unit: z.enum(['g', 'ml', 'piece', 'pack']),
        unit_grams: z.number().positive().max(3000).optional().describe('Weight of one piece/pack in grams, only if stated'),
        origin: z.enum(['user', 'label', 'web']).default('user'),
        source_ref: z.string().url().max(500).optional().describe('Required for origin=web: the page URL'),
        confirm_mismatch: z.boolean().optional().describe('true only if the person confirmed numbers that failed the calorie check'),
      }),
      execute: async (a) => {
        if (a.origin === 'web' && !a.source_ref) return { error: 'source_ref (URL) is required for origin=web' };
        const input = { ...a, origin: a.origin, source_ref: a.source_ref ?? null };
        try {
          if (ctx.dry) {
            const numbers = userFoodNumbers(input, { allowMismatch: a.confirm_mismatch });
            const row = userFoodRow(userId, input, numbers);
            const food = { ...row, id: crypto.randomUUID(), portions: row.portions } as unknown as Food;
            ctx.dry.foods.set(food.id, food);
            ctx.dry.effects.push({ kind: 'food', food_id: food.id, name: food.name_ru, kcal_100g: numbers.per100.kcal });
            return { saved: true, dry_run: true, food_id: food.id, name: food.name_ru, per100: numbers.per100, portion: numbers.portion, note: numbers.note };
          }
          const res = await saveUserFood(sb, userId, input, { allowMismatch: a.confirm_mismatch });
          const per = a.unit === 'ml' ? 'ккал/100 мл' : 'ккал/100 г';
          ctx.ui.actions.push({ kind: 'food', text: `${res.created ? 'Продукт сохранён' : 'Продукт уже был'}: ${res.food.name_ru} · ${Math.round(Number(res.food.kcal_100g))} ${per}` });
          return {
            saved: true, created: res.created, food_id: res.food.id, name: res.food.name_ru, per100: res.numbers.per100, portion: res.numbers.portion,
            macros_known: res.numbers.confidence === 'high', note: res.numbers.note, replaced_old_versions: res.replacedIds.length,
            next: 'log_meal с этим food_id (граммы = порция), или edit_meal с replace, если исправляешь уже записанное',
          };
        } catch (e) {
          if (e instanceof UserFoodError) return { error: e.code, message: e.message, detail: e.detail, hint: 'Переспроси человека про цифры; если он подтверждает — confirm_mismatch: true' };
          throw e;
        }
      },
    }),

    edit_meal: tool({
      description: 'Fix an existing meal (new version, history kept): replace items (e.g. with a food_id from save_user_food), change grams, time, slot or title. Use this — not log_meal — when the person says «исправь», «там 250 ккал», «всё ещё висит». Returns what is really in the database after the edit: report those numbers.',
      inputSchema: z.object({
        meal_id: z.string().uuid(),
        replace: z.array(z.object({
          item: z.string().max(80).describe('Current item: a word of its name or its 1-based number'),
          food_id: z.string().uuid().describe('New food from save_user_food or search_foods'),
          grams: z.number().positive().max(5000).optional().describe('Default: the old grams'),
        })).max(10).optional(),
        items: z.array(z.object({ food_id: z.string().uuid(), grams: z.number().positive().max(5000) })).min(1).max(20).optional().describe('Full new item list (instead of replace)'),
        time_local: hhmm.optional(),
        slot: slotSchema.optional(),
        title: z.string().max(80).optional(),
      }),
      execute: async (a) => {
        const meal = await loadMeal(ctx, a.meal_id);
        if (!meal) return { error: 'meal not found or deleted', hint: 'возьми id из get_day_summary' };
        if (!a.replace?.length && !a.items?.length && !a.time_local && !a.slot && !a.title) return { error: 'nothing to change' };
        const foods = new Map<string, Food>();
        for (const id of new Set([...(a.items ?? []).map((i) => i.food_id), ...(a.replace ?? []).map((r) => r.food_id)])) {
          const f = await loadFood(ctx, id);
          if (!f) return { error: `food_id not found: ${id}`, hint: 'сначала save_user_food (цифры человека) или search_foods' };
          foods.set(id, f);
        }
        // Kept items keep their food link (the database recomputes them) and per-100 g snapshot.
        type NextItem = { food: Food | null; food_id: string | null; name: string; grams: number; per100: Per100 | null; changed: boolean };
        const fromFood = (f: Food, grams: number): NextItem => ({ food: f, food_id: f.id, name: f.name_ru, grams, per100: per100Of(f), changed: true });
        let next: NextItem[] = meal.items.map((i) => ({ food: null, food_id: i.food_id, name: i.name, grams: i.grams, per100: i.per100, changed: false }));
        if (a.items?.length) {
          next = a.items.map((i) => fromFood(foods.get(i.food_id)!, i.grams));
        } else {
          for (const op of a.replace ?? []) {
            const idx = findItem(meal.items, op.item);
            if (idx < 0) return { error: `item not found: ${op.item}`, items: meal.items.map((i, n) => `${n + 1}. ${i.name} ${i.grams} г`) };
            next[idx] = fromFood(foods.get(op.food_id)!, op.grams ?? meal.items[idx].grams);
          }
        }
        const titleItems = next.map((n) => ({ name: n.name, brand: n.food?.brand ?? null }));
        const title = mealTitle(titleItems, a.title ?? acceptableTitle(meal.title, titleItems));
        const eatenAt = a.time_local ? instantForLocal(meal.local_day, a.time_local.padStart(5, '0'), ctx.profile.timezone, ctx.profile.day_boundary_minutes).toISOString() : meal.eaten_at;

        if (ctx.dry) {
          const old = adoptIntoDry(ctx, meal);
          const items = next.map((n) => (n.food ? dryItem(n.food, n.grams) : { food_id: n.food_id, name: n.name, grams: n.grams, ...(n.per100 ? macrosFor(n.grams, n.per100) : { kcal: 0, protein_g: 0, fat_g: 0, carbs_g: 0 }), partial: Boolean(n.per100?.partial) }));
          const id = crypto.randomUUID();
          ctx.dry.meals.set(old.id, { ...old, is_current: false });
          const fresh: DryMeal = { ...old, id, title, slot: a.slot ?? old.slot, eaten_at: eatenAt, is_current: true, items };
          ctx.dry.meals.set(id, fresh);
          const back = readBack(fresh);
          ctx.dry.effects.push({ kind: 'edit', meal_id: id, root_id: old.root_id, title, kcal: back.kcal });
          ctx.ui.actions.push({ kind: 'meal_edit', text: `Исправлено: ${title} · ${back.kcal} ккал` });
          return { saved: true, dry_run: true, in_database_now: back, note_for_reply: 'Назови эти цифры: это то, что сейчас записано.' };
        }

        const saved = await saveMeal(sb, userId, {
          supersedes_id: meal.id, eaten_at: eatenAt, slot: a.slot ?? undefined, title, input_method: 'agent',
          items: next.map((n) => ({ food_id: n.food_id, name: n.name, grams: r1(n.grams), per100: n.per100, source: 'agent' as const, edited: n.changed })),
        });
        const fresh = await loadMeal(ctx, saved.id);
        if (!fresh) return { error: 'edit saved but the meal could not be read back', meal_id: saved.id };
        const back = readBack({ id: fresh.id, title: fresh.title ?? title, items: fresh.items.map((i) => ({ food_id: i.food_id, name: i.name, grams: i.grams, ...(i.per100 ? macrosFor(i.grams, i.per100) : { kcal: 0, protein_g: 0, fat_g: 0, carbs_g: 0 }), partial: Boolean(i.per100?.partial) })) });
        ctx.ui.actions.push({ kind: 'meal_edit', text: `Исправлено: ${back.title} · ${back.kcal} ккал · б ${back.protein_g}` });
        return { saved: true, in_database_now: back, note_for_reply: 'Назови эти цифры: это то, что сейчас записано.' };
      },
    }),

    delete_meal: tool({
      description: 'Delete a meal. A meal YOU logged in this conversation within the last 30 minutes (your own mistake) is deleted at once; any other meal needs the person to confirm with a button — then do not claim it is deleted.',
      inputSchema: z.object({ meal_id: z.string().uuid(), reason: z.string().max(200).optional() }),
      execute: async ({ meal_id }) => {
        const meal = await loadMeal(ctx, meal_id);
        if (!meal) return { error: 'meal not found or already deleted' };
        const kcal = Math.round(meal.items.reduce((s, i) => s + (i.per100 ? macrosFor(i.grams, i.per100).kcal : 0), 0));
        const label = `«${meal.title ?? 'приём'}» (${kcal} ккал)`;
        const ownUndo = meal.recentOwn && (ctx.trigger === 'chat' || ctx.trigger === 'eval');
        if (ownUndo) {
          if (ctx.dry) {
            const old = adoptIntoDry(ctx, meal);
            ctx.dry.meals.set(old.id, { ...old, status: 'deleted' });
            ctx.dry.effects.push({ kind: 'delete', meal_id: old.id, root_id: old.root_id, immediate: true });
          } else {
            const { error } = await sb.rpc('delete_meal', { p_id: meal.id });
            if (error) return { error: 'delete failed' };
          }
          ctx.ui.actions.push({ kind: 'meal_edit', text: `Удалил ошибочную запись ${label}` });
          return { deleted: true, immediate: true, summary: `Удалено: ${label}` };
        }
        const action: PendingAction = { id: crypto.randomUUID(), kind: 'delete_meal', summary: `Удалить ${label}?`, params: { meal_id: meal.id } };
        ctx.ui.pendingActions.push(action);
        if (ctx.dry) ctx.dry.effects.push({ kind: 'delete', meal_id: meal.id, root_id: meal.root_id, immediate: false });
        return { status: 'awaiting_user_confirmation', summary: action.summary };
      },
    }),
  };
}

/**
 * Links a meal logged from chat photos to its raw inputs: one `recognitions` row per agent
 * run (kind photo), so photo → recognition → meal stays traceable like on the log screen.
 */
async function photoRecognition(ctx: ToolCtx, items: { name: string; grams: number }[]): Promise<string | null> {
  if (!ctx.photo?.mediaIds.length) return null;
  const { data, error } = await ctx.sb.from('recognitions').insert({
    user_id: ctx.userId, kind: 'photo', media_ids: ctx.photo.mediaIds, pipeline_version: 'chat-agent-v1', prompt_version: 'agent',
    runs: [{ provider: 'chatgpt', model: ctx.photo.model, run_id: ctx.runId }], result: { items }, status: 'done',
  }).select('id').single();
  if (error) return null;
  return data.id as string;
}
