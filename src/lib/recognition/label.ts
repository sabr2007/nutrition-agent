import { z } from 'zod';
import { checkLabelNumbers, kcalFromMacros, MACRO_SUM_LIMIT } from '@/lib/nutrition/label-math';

// Nutrition-label reading. The model only transcribes the printed numbers; everything
// else (unit conversion, per-serving → per-100 g, sanity checks) is deterministic code.

export const LABEL_PROMPT_VERSION = 'label-v1';

const Nutrients = z.object({
  kcal: z.number().nullable().describe('Энергетическая ценность в ккал, как напечатано'),
  kj: z.number().nullable().describe('Энергетическая ценность в кДж, если напечатана'),
  protein: z.number().nullable().describe('Белки, г'),
  fat: z.number().nullable().describe('Жиры, г'),
  carbs: z.number().nullable().describe('Углеводы, г'),
  fiber: z.number().nullable().describe('Пищевые волокна / клетчатка, г'),
});
export type LabelNutrients = z.infer<typeof Nutrients>;

export const LabelOutput = z.object({
  is_label: z.boolean().describe('true, если на фото видна пищевая ценность (таблица или строка с белками/жирами/углеводами/калорийностью)'),
  name: z.string().nullable().describe('Название продукта с упаковки, если видно'),
  brand: z.string().nullable().describe('Бренд/производитель, если виден'),
  // Plain objects with nullable fields (not nullable objects): some models reject anyOf schemas.
  per100: Nutrients.describe('Значения «на 100 г» или «на 100 мл»; все поля null, если такой колонки нет'),
  per100_unit: z.enum(['g', 'ml']).describe('g — на 100 г (или не указано), ml — на 100 мл'),
  per_serving: Nutrients.describe('Значения «на порцию»; все поля null, если их нет'),
  serving_g: z.number().nullable().describe('Масса или объём порции, если указан'),
  package_g: z.number().nullable().describe('Масса нетто упаковки, если видна'),
  prepared: z.boolean().describe('true, если значения указаны для готового (приготовленного) продукта'),
  confidence: z.number().describe('0..1 — насколько чётко читаются цифры'),
  // Kept last and short: some models loop on whitespace after a trailing number or nullable field.
  state: z.enum(['dry', 'as_is', 'cooked']).describe('dry — крупы, хлопья, каши и макароны, которые варят; as_is — готово к употреблению; cooked — значения для приготовленного'),
});
export type LabelOutput = z.infer<typeof LabelOutput>;

export function labelSystemPrompt(): string {
  return `Ты читаешь этикетку продукта на фото и переписываешь пищевую ценность для дневника питания.
Правила:
- Переписывай числа ТОЧНО как напечатано. Ничего не считай и не додумывай: если значения нет или оно не читается — null.
- Запятая — десятичный разделитель: «12,5 г» → 12.5. «менее 0,5» → 0.5.
- «Энергетическая ценность (калорийность)»: ккал → kcal, кДж → kj. Если напечатано «350 ккал/1465 кДж» — оба числа.
- Колонка или строка «на 100 г» → per100 (per100_unit = g), «на 100 мл» → per100 (per100_unit = ml). «На порцию»/«в 1 порции (40 г)» → per_serving и serving_g.
- Если значения указаны «в готовом продукте» или «после приготовления» — prepared = true.
- name и brand — как на упаковке, по-русски, если видны; иначе null.
- state: dry для круп, хлопьев, каш быстрого приготовления и макарон, которые нужно варить; as_is для готового к употреблению; cooked, если цифры для приготовленного продукта.
- Если на фото нет пищевой ценности (только упаковка, штрихкод или еда) — is_label = false и null в числах.
- confidence 0..1: насколько уверенно читаются цифры (блики, размытие, обрезано — ниже).`;
}

export type LabelWarningCode = 'per_serving' | 'missing' | 'macro_sum' | 'kj' | 'kcal_from_macros' | 'mismatch' | 'per_ml' | 'prepared';
export type LabelWarning = { code: LabelWarningCode; text: string };

export type NormalizedLabel = {
  name: string | null;
  brand: string | null;
  state: 'dry' | 'as_is' | 'cooked';
  unit: 'g' | 'ml';
  per100: { kcal: number; protein: number; fat: number; carbs: number; fiber: number | null };
  servingG: number | null;
  packageG: number | null;
  kcalFromMacros: number;
  warnings: LabelWarning[];
  confidence: number;
};

const KJ_PER_KCAL = 4.184;

const r1 = (n: number) => Math.round(n * 10) / 10;
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const num = (n: number | null | undefined): number | null => (n != null && Number.isFinite(n) && n >= 0 ? n : null);

function hasValues(n: LabelNutrients | null | undefined): n is LabelNutrients {
  return !!n && [n.kcal, n.kj, n.protein, n.fat, n.carbs].some((v) => num(v) != null);
}

export { kcalFromMacros };

/**
 * Turns the model transcript into per-100 g values with warnings the user should see.
 * Throws when there is nothing usable to save.
 */
export function normalizeLabel(out: LabelOutput): NormalizedLabel {
  const warnings: LabelWarning[] = [];
  const warn = (code: LabelWarningCode, text: string) => warnings.push({ code, text });
  const servingG = num(out.serving_g);
  let source: LabelNutrients;
  let factor = 1;
  if (hasValues(out.per100)) {
    source = out.per100;
  } else if (hasValues(out.per_serving) && servingG && servingG > 0) {
    source = out.per_serving;
    factor = 100 / servingG;
    warn('per_serving', `На этикетке цифры на порцию ${Math.round(servingG)} г — пересчитал на 100 г.`);
  } else if (hasValues(out.per_serving)) {
    throw new Error('На этикетке цифры на порцию, но не видно её массы. Сфоткай строку с массой порции или введи цифры на 100 г.');
  } else if (!out.is_label) {
    throw new Error('Не вижу на фото пищевую ценность. Сфоткай таблицу с белками, жирами, углеводами ближе.');
  } else {
    throw new Error('Не разобрал цифры на этикетке. Сфоткай ближе, без бликов, или введи вручную.');
  }

  const scaled = (v: number | null | undefined) => {
    const n = num(v);
    return n == null ? null : n * factor;
  };
  const protein = scaled(source.protein);
  const fat = scaled(source.fat);
  const carbs = scaled(source.carbs);
  const fiber = scaled(source.fiber);
  const missing = [protein == null && 'белки', fat == null && 'жиры', carbs == null && 'углеводы'].filter(Boolean);
  if (missing.length) warn('missing', `Не прочитал: ${missing.join(', ')} — проверь по упаковке.`);
  const p = clamp(protein ?? 0, 0, 100);
  const f = clamp(fat ?? 0, 0, 100);
  const c = clamp(carbs ?? 0, 0, 100);
  if (p + f + c > MACRO_SUM_LIMIT) warn('macro_sum', 'Белков, жиров и углеводов вместе больше 100 г на 100 г — скорее всего, цифра прочитана неверно.');

  const calc = kcalFromMacros(p, f, c);
  let kcal = scaled(source.kcal);
  const kj = scaled(source.kj);
  if (kcal == null && kj != null) {
    kcal = kj / KJ_PER_KCAL;
    warn('kj', 'Калорийность указана только в кДж — перевёл в ккал.');
  }
  if (kcal == null) {
    if (!missing.length || calc > 0) {
      kcal = calc;
      warn('kcal_from_macros', 'Калорийность не прочитал — посчитал по белкам, жирам и углеводам.');
    } else {
      throw new Error('Не разобрал ни калорийность, ни БЖУ. Сфоткай этикетку ближе или введи вручную.');
    }
  }
  kcal = clamp(kcal, 0, 900);
  if (checkLabelNumbers(kcal, p, f, c).kcalMismatch && !missing.length) {
    warn('mismatch', `Калории не сходятся с БЖУ: по БЖУ ≈ ${Math.round(calc)} ккал, на этикетке ${Math.round(kcal)}. Сверь цифры с упаковкой.`);
  }

  const unit = out.per100_unit === 'ml' ? 'ml' : 'g';
  if (unit === 'ml') warn('per_ml', 'Цифры на 100 мл: для жидкостей вес примерно равен объёму.');
  if (out.prepared) warn('prepared', 'Цифры для готового продукта — вводи вес готовой порции.');
  const state = out.prepared ? 'cooked' : out.state;

  return {
    name: out.name?.trim().slice(0, 160) || null,
    brand: out.brand?.trim().slice(0, 80) || null,
    state,
    unit,
    per100: { kcal: r1(kcal), protein: r1(p), fat: r1(f), carbs: r1(c), fiber: fiber == null ? null : r1(clamp(fiber, 0, 100)) },
    servingG: servingG ? r1(servingG) : null,
    packageG: num(out.package_g) ? r1(out.package_g!) : null,
    kcalFromMacros: calc,
    warnings,
    confidence: clamp(Number.isFinite(out.confidence) ? out.confidence : 0.5, 0, 1),
  };
}
