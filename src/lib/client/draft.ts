// Client-side draft of a meal on the confirmation screen.
import type { MealItemInput } from '@/lib/nutrition/types';
import type { ClarifyingQuestion } from '@/lib/recognition/schema';

export type DraftItem = MealItemInput & {
  key: string;
  label?: string;
  food_query?: string;
  grams_low?: number;
  grams_high?: number;
  unmatched?: boolean;
  alternatives?: { id: string; name_ru: string; state: string }[];
};

export type Draft = {
  source: 'photo' | 'text' | 'voice' | 'scale' | 'manual' | 'template' | 'edit' | 'barcode' | 'label';
  recognitionId: string | null;
  items: DraftItem[];
  questions: ClarifyingQuestion[];
  confidence: number | null;
  agreement: number | null;
  transcript?: string | null;
  photoUrl?: string | null;
  supersedesId?: string | null;
  templateId?: string | null;
  title?: string | null;
  slot?: string | null;
  shownAt: number;
  usedLlm?: boolean;
  models?: string[];
};

export function slotByTime(hour: number): string {
  if (hour >= 4 && hour < 12) return 'breakfast';
  if (hour >= 12 && hour < 16) return 'snack';
  if (hour >= 16 && hour < 20) return 'lunch';
  if (hour >= 20 && hour < 23) return 'dinner';
  return 'late';
}
