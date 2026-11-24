// Shared label sanity checks (server normalization + live checks in the form).

/** Above this share of difference the printed kcal and the macros disagree. */
export const MISMATCH_TOLERANCE = 0.15;
/** Protein + fat + carbs per 100 g cannot exceed 100 g (+ rounding on the label). */
export const MACRO_SUM_LIMIT = 100.5;
/** Small energy values (spices, drinks) make the relative check meaningless. */
const MIN_KCAL_FOR_CHECK = 20;

const r1 = (n: number) => Math.round(n * 10) / 10;

/** Atwater factors (4/9/4), the same estimate the label regulations use. */
export function kcalFromMacros(protein: number, fat: number, carbs: number): number {
  return r1(protein * 4 + fat * 9 + carbs * 4);
}

export type LabelCheck = { kcalFromMacros: number; kcalMismatch: boolean; macroSumTooHigh: boolean };

export function checkLabelNumbers(kcal: number, protein: number, fat: number, carbs: number): LabelCheck {
  const calc = kcalFromMacros(protein, fat, carbs);
  return {
    kcalFromMacros: calc,
    kcalMismatch: kcal > MIN_KCAL_FOR_CHECK && Math.abs(kcal - calc) / kcal > MISMATCH_TOLERANCE,
    macroSumTooHigh: protein + fat + carbs > MACRO_SUM_LIMIT,
  };
}
