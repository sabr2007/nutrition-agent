import type { DaySummary, DayMeal, ChecklistRow } from '@/lib/data/day';
export type { DaySummary, DayMeal, ChecklistRow };

export type TemplateLite = {
  id: string; key: string | null; name: string; slot: string; default_time: string | null; checklist_key: string | null;
  training_day_only: boolean; glyph: string | null; sort_order: number; kcal: number; protein_g: number; fat_g: number; carbs_g: number;
  items: { food_id: string; grams: number; name: string; note: string | null }[];
};

export type TodayResponse = {
  summary: DaySummary;
  templates: TemplateLite[];
  coach: { id: string; text: string; kind: string; created_at: string } | null;
  notification: { id: string; title: string; body: string; deep_link: string | null; rule_key: string | null; sent_at: string | null; status: string } | null;
};
