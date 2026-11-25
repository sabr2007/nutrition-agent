import 'server-only';
import { checkLabelNumbers } from '@/lib/nutrition/label-math';

// Open Food Facts (ODbL, crowd-sourced): search by name/brand, read a product by barcode, and
// keep only products whose numbers hold together (Atwater, ≤ 900 kcal/100 g). Their policy
// asks for a descriptive User-Agent; it carries no personal data.

const UA = 'Ryadom/1.0 (personal open-source nutrition app; +https://github.com/sabr2007/nutrition-agent)';
const TIMEOUT_MS = 8000;
const FIELDS = 'code,product_name,product_name_ru,brands,quantity,serving_quantity,categories_tags,nutriments';
const MAX_CANDIDATES = 4;

export type OffProduct = {
  code: string; name: string; brand: string | null; url: string; isDrink: boolean;
  per100: { kcal: number; protein: number | null; fat: number | null; carbs: number | null; satfat: number | null; sugar: number | null };
  servingG: number | null;
};

type RawProduct = {
  code?: string; product_name?: string; product_name_ru?: string; brands?: string; serving_quantity?: number | string;
  categories_tags?: string[]; nutriments?: Record<string, number | string | undefined>;
};

const num = (v: unknown): number | null => {
  const n = typeof v === 'string' ? Number.parseFloat(v) : typeof v === 'number' ? v : Number.NaN;
  return Number.isFinite(n) && n >= 0 ? n : null;
};

/** A product with usable, self-consistent numbers per 100 g/ml — or null. */
export function parseOffProduct(p: RawProduct | undefined): OffProduct | null {
  if (!p?.code) return null;
  const n = p.nutriments ?? {};
  const kcal = num(n['energy-kcal_100g']) ?? (num(n['energy_100g']) != null ? num(n['energy_100g'])! / 4.184 : null);
  if (kcal == null || kcal > 900) return null;
  const protein = num(n['proteins_100g']);
  const fat = num(n['fat_100g']);
  const carbs = num(n['carbohydrates_100g']);
  // Missing macros count as 0 for the check: a drink with 11 g sugar cannot have 203 kcal.
  const check = checkLabelNumbers(kcal, protein ?? 0, fat ?? 0, carbs ?? 0);
  const alcohol = num(n['alcohol_100g']) ?? 0;
  if ((check.kcalMismatch && alcohol < 0.5) || check.macroSumTooHigh) return null;
  const name = (p.product_name_ru || p.product_name || '').trim();
  if (!name) return null;
  const brand = p.brands?.split(',')[0]?.trim() || null;
  return {
    code: p.code, name: name.slice(0, 160), brand: brand?.slice(0, 80) ?? null,
    url: `https://world.openfoodfacts.org/product/${p.code}`,
    isDrink: (p.categories_tags ?? []).some((t) => /beverages|drinks|boissons/.test(t)),
    per100: { kcal: Math.round(kcal * 10) / 10, protein, fat, carbs, satfat: num(n['saturated-fat_100g']), sugar: num(n['sugars_100g']) },
    servingG: num(p.serving_quantity),
  };
}

async function get<T>(url: string): Promise<T | null> {
  const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(TIMEOUT_MS) }).catch(() => null);
  if (!res?.ok) return null;
  return (await res.json().catch(() => null)) as T | null;
}

export async function offByBarcode(code: string): Promise<OffProduct | null> {
  if (!/^\d{8,14}$/.test(code)) return null;
  const body = await get<{ status?: number; product?: RawProduct }>(`https://world.openfoodfacts.org/api/v2/product/${code}.json?fields=${FIELDS}`);
  return body?.status === 1 ? parseOffProduct({ ...body.product, code }) : null;
}

/** Products matching the query, best first, only those with consistent numbers. */
export async function offSearch(query: string): Promise<OffProduct[]> {
  const q = encodeURIComponent(query.trim().slice(0, 100));
  const found = await get<{ hits?: { code?: string }[] }>(`https://search.openfoodfacts.org/search?q=${q}&page_size=${MAX_CANDIDATES * 2}&fields=code`);
  const codes = [...new Set((found?.hits ?? []).map((h) => h.code).filter((c): c is string => Boolean(c)))].slice(0, MAX_CANDIDATES);
  const products = await Promise.all(codes.map((c) => offByBarcode(c)));
  return products.filter((p): p is OffProduct => Boolean(p));
}
