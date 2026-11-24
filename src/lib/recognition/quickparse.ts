// Free, instant parser for simple inputs ("грудка 250", "3 яйца", "творог 200 г, банан").
// Anything more complex goes to the LLM text parser.

export type QuickSegment = { query: string; grams: number | null; count: number | null; state: 'raw' | 'cooked' | 'dry' | null };

const UNIT_RE = /^(г|гр|грамм|грамма|граммов|g)$/i;
const STATE_WORDS: Record<string, QuickSegment['state']> = {
  сырой: 'raw', сырая: 'raw', сырые: 'raw', сырого: 'raw', сырых: 'raw',
  сухой: 'dry', сухая: 'dry', сухие: 'dry', сухого: 'dry', сухих: 'dry',
  варёная: 'cooked', вареная: 'cooked', варёный: 'cooked', вареный: 'cooked', готовая: 'cooked', готовый: 'cooked',
};
const NUMBER_WORDS: Record<string, number> = { одно: 1, один: 1, одна: 1, два: 2, две: 2, три: 3, четыре: 4, пять: 5, шесть: 6 };

export function quickParse(text: string): QuickSegment[] | null {
  const cleaned = text.toLowerCase().replace(/ё/g, 'е').trim();
  if (!cleaned || cleaned.length > 160) return null;
  const parts = cleaned.split(/\s*(?:,|;|\+|\n)\s*|\s+и\s+/).map((s) => s.trim()).filter(Boolean);
  if (!parts.length || parts.length > 6) return null;
  const out: QuickSegment[] = [];
  for (const part of parts) {
    const tokens = part.split(/\s+/);
    let grams: number | null = null;
    let count: number | null = null;
    let state: QuickSegment['state'] = null;
    const words: string[] = [];
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      const num = /^(\d+(?:[.,]\d+)?)(г|гр|g)?$/.exec(t);
      if (num) {
        const n = Number(num[1].replace(',', '.'));
        const nextIsUnit = num[2] || UNIT_RE.test(tokens[i + 1] ?? '');
        if (nextIsUnit && !num[2]) i++;
        if (nextIsUnit || n >= 20) grams = n;
        else count = n;
        continue;
      }
      if (/^(шт|штук|штуки|штука)$/.test(t)) continue;
      if (NUMBER_WORDS[t] && !words.length) { count = NUMBER_WORDS[t]; continue; }
      if (STATE_WORDS[t]) { state = STATE_WORDS[t]; words.push(t); continue; }
      words.push(t);
    }
    const query = words.join(' ').trim();
    // Too many words = probably a sentence ("съел на обеде у мамы ...") → LLM.
    if (!query || words.length > 4 || /\d/.test(query)) return null;
    out.push({ query, grams, count, state });
  }
  return out;
}
