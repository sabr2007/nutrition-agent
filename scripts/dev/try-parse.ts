import { createClient } from '@supabase/supabase-js';
import { parseFoodText } from '@/lib/recognition/pipeline';

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SECRET_KEY!, { auth: { persistSession: false } });
const userId = process.argv[2];
for (const text of process.argv.slice(3)) {
  const t0 = Date.now();
  try {
    const r = await parseFoodText({ sb, userId, text, kind: 'text' });
    console.log(`\n«${text}» llm=${r.usedLlm} ${Date.now() - t0}ms conf=${r.confidence} models=${r.models.join(',')}`);
    for (const it of r.items) console.log(`  - ${it.name} ${it.grams}г → ${it.kcal} ккал, Б${it.protein_g} conf=${it.confidence} ${it.unmatched ? 'UNMATCHED' : ''}`);
    for (const q of r.questions) console.log(`  ? ${q.text} [${q.options.map((o) => o.label).join(' | ')}]`);
  } catch (e) { console.log('ERR', (e as Error).message); }
}
