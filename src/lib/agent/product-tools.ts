import 'server-only';
import { tool, type ToolSet } from 'ai';
import { z } from 'zod';
import { saveCatalogFood } from '@/lib/data/foods';
import { offByBarcode, offSearch, type OffProduct } from '@/lib/foods/off';
import { webNutrition, type WebFood, type WebMiss } from '@/lib/foods/web';
import type { Food } from '@/lib/nutrition/types';
import { searchFoodsSmart } from '@/lib/recognition/match';
import { isContent, relevanceGate, sameStem, tokens } from '@/lib/recognition/relevance';

/** Variant words a product name may carry that change what it is («Coca-Cola Zero» ≠ «Coca-Cola»). */
const VARIANT = /^(zero|light|lite|diet|sugar|free|без|лайт|зеро|диет|cherry|vanilla|lemon|lime|peach|mango|вишн|ванил|лимон|лайм|персик|манго|клубник|малин|шоколадн|карамел)/;

/** The product name carries a variant word the query does not («zero», «вишня»). */
function unaskedVariant(query: string, f: { name_ru: string; brand?: string | null }): boolean {
  const q = tokens(query).filter(isContent);
  return tokens(`${f.name_ru} ${f.brand ?? ''}`).filter(isContent).some((w) => VARIANT.test(w) && !q.some((x) => sameStem(x, w)));
}

/** Products the query names best first: fewer unasked variant words, more of the name covered. */
function rankByName<T extends { name_ru: string; brand?: string | null }>(query: string, items: T[]): T[] {
  const q = tokens(query).filter(isContent);
  const score = (f: T) => {
    const words = tokens(`${f.name_ru} ${f.brand ?? ''}`).filter(isContent);
    const extra = words.filter((w) => !q.some((x) => sameStem(x, w)));
    return extra.filter((w) => VARIANT.test(w)).length * 10 + extra.length;
  };
  return [...items].sort((a, b) => score(a) - score(b));
}
import type { ToolCtx } from './tool-ctx';

// lookup_product (D26): personal base → Open Food Facts → the web. A found product is saved with
// its source URL after the numbers are checked (Atwater), and the agent logs it with log_meal —
// so calories still come from the food base, never from the model's text.

const asFood = (id: string, name: string, brand: string | null, isDrink: boolean, per100: { kcal: number; protein: number | null; fat: number | null; carbs: number | null }): Food => ({
  id, user_id: 'external', source: 'external', name_ru: name, name_en: null, brand, aliases: [], category: isDrink ? 'drinks' : null, state: 'as_is',
  kcal_100g: per100.kcal, protein_100g: per100.protein, fat_100g: per100.fat, carbs_100g: per100.carbs, confidence: 'medium', score: 2,
});

function reply(source: string, f: Food, url: string | null) {
  return {
    found: true, source, food_id: f.id, name: f.name_ru, brand: f.brand ?? null,
    per100: { kcal: Number(f.kcal_100g), protein: f.protein_100g == null ? null : Number(f.protein_100g), fat: f.fat_100g == null ? null : Number(f.fat_100g), carbs: f.carbs_100g == null ? null : Number(f.carbs_100g) },
    basis: f.category === 'drinks' ? '100ml' : '100g', url, usual_portion_g: f.default_portion_g != null ? Number(f.default_portion_g) : null,
    next: 'log_meal с этим food_id и граммами (с весов, со слов или порция). В ответе одна строка расчёта: «X, N г × K ккал/100 г = M ккал».',
  };
}

export function productTools(ctx: ToolCtx): ToolSet {
  const { sb, userId } = ctx;

  async function save(input: Parameters<typeof saveCatalogFood>[2]): Promise<Food> {
    if (ctx.dry) {
      const food = { ...asFood(crypto.randomUUID(), input.name, input.brand ?? null, Boolean(input.isDrink), input.per100), user_id: userId, source: input.source, satfat_100g: input.per100.satfat ?? null, sugar_100g: input.per100.sugar ?? null, default_portion_g: input.servingG ?? null } as Food;
      ctx.dry.foods.set(food.id, food);
      ctx.dry.effects.push({ kind: 'food', food_id: food.id, name: food.name_ru, kcal_100g: Number(food.kcal_100g) });
      return food;
    }
    const { food, created } = await saveCatalogFood(sb, userId, input);
    ctx.ui.actions.push({ kind: 'food', text: `${created ? 'Продукт найден и сохранён' : 'Продукт уже был'}: ${food.name_ru} · ${Math.round(Number(food.kcal_100g))} ккал/100 ${food.category === 'drinks' ? 'мл' : 'г'}` });
    return food;
  }

  return {
    lookup_product: tool({
      description: 'Find a packaged or branded product and its nutrition per 100 g/ml: personal food base → Open Food Facts → the web (official pages). A found product is checked, saved with its source URL and returned with food_id for log_meal. Use for brands, packaged foods, a barcode, a product on kitchen scales, or when log_meal returned needs_food and the person gave no numbers.',
      inputSchema: z.object({
        name: z.string().max(120).optional().describe('Product name as on the package: «Fuse Tea лимон», «конфеты Ромашка»'),
        brand: z.string().max(80).optional(),
        barcode: z.string().regex(/^\d{8,14}$/).optional(),
      }),
      execute: async (a) => {
        const query = [a.brand, a.name].filter(Boolean).join(' ').trim();
        if (!query && !a.barcode) return { error: 'name, brand or barcode is required' };
        // 1. What the person already has (and the shared base, by barcode).
        if (a.barcode) {
          const { data } = await sb.from('foods').select('*').eq('barcode', a.barcode).is('archived_at', null).or(`user_id.is.null,user_id.eq.${userId}`).limit(1);
          if (data?.[0]) return reply('base', data[0] as Food, null);
        }
        if (query) {
          const own = [...(ctx.dry ? [...ctx.dry.foods.values()].map((f) => ({ ...f, score: 2.2 })) : []), ...(await searchFoodsSmart(sb, query, 8)).filter((f) => f.user_id)];
          const gate = relevanceGate(query, own, { brand: a.brand });
          if (gate.ok) return reply('personal', gate.pool[0], null);
        }
        // 2. Open Food Facts: crowd-sourced, kept only when the numbers hold together.
        const off: OffProduct[] = a.barcode ? [await offByBarcode(a.barcode)].filter((p): p is OffProduct => Boolean(p)) : await offSearch(query);
        const offFoods = off.map((p) => asFood(p.code, p.name, p.brand, p.isDrink, p.per100));
        const offGate = a.barcode && offFoods.length ? { ok: true as const, pool: offFoods } : query ? relevanceGate(query, offFoods, { brand: a.brand }) : null;
        // A variant the person did not name («Zero» for «Coca-Cola») is not a match at all.
        const offPool = offGate?.ok ? (a.barcode ? offGate.pool : rankByName(query, offGate.pool).filter((f) => !unaskedVariant(query, f))) : [];
        if (offPool.length) {
          const pick = offPool[0];
          const p = off.find((x) => x.code === pick.id)!;
          const food = await save({ source: 'off', source_ref: p.url, barcode: p.code, name: p.name, brand: p.brand, isDrink: p.isDrink, per100: p.per100, servingG: p.servingG });
          return reply('open_food_facts', food, p.url);
        }
        // 3. The web: the plan's built-in search, numbers copied from the page, then checked.
        let web: WebFood | null = null;
        let webMiss: WebMiss | 'error' | 'not_relevant' | null = null;
        try {
          const r = await webNutrition(userId, `${query}${a.barcode ? ` (штрихкод ${a.barcode})` : ''}`, ctx.runId);
          if ('miss' in r) {
            webMiss = r.miss;
            console.warn('[lookup_product] web miss', r.miss, r.detail?.slice(0, 160));
          } else web = r;
        } catch (e) {
          webMiss = 'error';
          console.warn('[lookup_product] web error', (e as Error).message?.slice(0, 160));
        }
        if (web) {
          const candidate = asFood('web', web.name, web.brand, web.basis === '100ml', web.per100);
          const webGate = query ? relevanceGate(query, [candidate], { brand: a.brand }) : { ok: true };
          if (webGate.ok) {
            const food = await save({ source: 'web', source_ref: web.url, name: web.name, brand: web.brand, isDrink: web.basis === '100ml', per100: web.per100 });
            return reply('web', food, web.url);
          }
        }
        if (web && !webMiss) webMiss = 'not_relevant';
        return { found: false, checked: { personal: true, open_food_facts: off.length, web: webMiss }, hint: 'Надёжных цифр не нашёл. Спроси кнопками (ask_user): «Скажу калорийность», «Сфоткаю этикетку»; похожий общий продукт — только если он выберет его сам (allow_generic).' };
      },
    }),
  };
}
