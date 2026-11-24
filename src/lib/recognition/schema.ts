import { z } from 'zod';

// What the vision/text model is allowed to output: recognition only, never calories.
export const RecognizedItem = z.object({
  label_ru: z.string().describe('Короткое название как видишь: "Гречка варёная"'),
  food_query: z.string().describe('Поисковый запрос для базы продуктов на русском: "гречка варёная"'),
  state: z.enum(['raw', 'cooked', 'dry', 'as_is']).describe('raw — сырое, cooked — приготовленное, dry — сухая крупа, as_is — как продаётся'),
  cooking_method: z.string().nullable().describe('варёная / запечённая / жареная на масле / тушёная / свежая / null'),
  grams: z.number().describe('Лучшая оценка массы в граммах в том состоянии, что на фото'),
  grams_low: z.number().describe('Нижняя граница (80% интервал)'),
  grams_high: z.number().describe('Верхняя граница (80% интервал)'),
  count: z.number().nullable().describe('Количество штук для штучного (яйца, манты, баурсаки), иначе null'),
  visible_fat: z.enum(['none', 'little', 'moderate', 'lots']).nullable().describe('Видимое масло/жир/соус на этом продукте'),
  confidence: z.number().describe('0..1 — уверенность и в продукте, и в массе'),
});
export type RecognizedItem = z.infer<typeof RecognizedItem>;

export const QuestionOption = z.object({
  label: z.string().describe('Текст кнопки, 1–3 слова: "Нет", "1 ч.л.", "~250 г"'),
  effect: z.enum(['none', 'set_grams', 'add_item', 'remove_item']),
  item_index: z.number().nullable().describe('Индекс позиции для set_grams/remove_item'),
  grams: z.number().nullable(),
  food_query: z.string().nullable().describe('Для add_item: что добавить, например "масло подсолнечное"'),
});

export const ClarifyingQuestion = z.object({
  id: z.string(),
  text: z.string().describe('Короткий вопрос на «ты»: "Масло добавлял?"'),
  options: z.array(QuestionOption).describe('2–4 варианта'),
});
export type ClarifyingQuestion = z.infer<typeof ClarifyingQuestion>;

export const RecognitionOutput = z.object({
  items: z.array(RecognizedItem),
  scale_reference: z.string().nullable().describe('Чем оценивал масштаб: тарелка ~26 см, вилка, ладонь, весы, нет'),
  scale_reading_g: z.number().nullable().describe('Число на экране кухонных весов в граммах, если видно'),
  hidden_ingredients: z.array(z.string()).describe('Что может быть невидимо: масло для жарки, сахар, соус'),
  overall_confidence: z.number(),
  questions: z.array(ClarifyingQuestion).describe('0–2 вопроса, только если ответ сильно меняет калории'),
  notes: z.string().nullable(),
});
export type RecognitionOutput = z.infer<typeof RecognitionOutput>;

/** Post-validation: clamp nonsense the schema can't express. */
export function sanitize(out: RecognitionOutput): RecognitionOutput {
  const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Number.isFinite(n) ? n : lo));
  return {
    ...out,
    overall_confidence: clamp(out.overall_confidence, 0, 1),
    items: out.items
      .filter((i) => i.food_query?.trim() && i.grams > 0)
      .slice(0, 12)
      .map((i) => {
        const grams = clamp(i.grams, 1, 3000);
        const low = clamp(Math.min(i.grams_low || grams, grams), 1, grams);
        const high = clamp(Math.max(i.grams_high || grams, grams), grams, 4000);
        return { ...i, grams, grams_low: low, grams_high: high, confidence: clamp(i.confidence, 0, 1) };
      }),
    questions: (out.questions ?? []).slice(0, 2).map((q) => ({ ...q, options: q.options.slice(0, 4) })),
  };
}
