import { strToU8, zipSync } from 'fflate';
import { handler, requireUser } from '@/lib/http';
import { toCsv } from '@/lib/data/csv';

export const maxDuration = 120;

const TABLES = [
  'profiles', 'goals', 'meals', 'meal_items', 'meal_templates', 'meal_template_items', 'recognitions', 'meal_corrections',
  'media', 'checklist_items', 'checklist_marks', 'body_metrics', 'workouts', 'slips', 'memories', 'skills',
  'reminder_rules', 'notifications', 'agent_messages', 'agent_runs', 'llm_calls', 'recipes', 'shopping_lists', 'events',
];

// One-click export of everything the user owns (RLS-scoped). For Parquet use
// `uv run scripts/export.py` (see README).
export const GET = handler(async (req) => {
  const { userId, sb } = await requireUser(req);
  const files: Record<string, Uint8Array> = {};
  for (const table of TABLES) {
    const rows: Record<string, unknown>[] = [];
    for (let from = 0; ; from += 1000) {
      const q = sb.from(table).select('*').range(from, from + 999);
      const { data, error } = table === 'skills' ? await q.eq('user_id', userId) : await q;
      if (error) break;
      rows.push(...((data ?? []) as Record<string, unknown>[]).map((r) => { const { embedding: _e, tsv: _t, ...rest } = r; return rest; }));
      if (!data || data.length < 1000) break;
    }
    files[`${table}.csv`] = strToU8(toCsv(rows));
  }
  const { data: foods } = await sb.from('foods').select('*').eq('user_id', userId);
  files['foods_personal.csv'] = strToU8(toCsv((foods ?? []).map(({ tsv: _t, ...r }) => r)));
  files['README.txt'] = strToU8(`Экспорт данных «Рядом» от ${new Date().toISOString()}\nВремя в UTC (timestamptz). local_day — учётный день (Asia/Almaty, граница дня из profiles.day_boundary_minutes).\nmeals: версии приёмов (is_current = актуальная), events: журнал всех изменений.\n`);
  const zip = zipSync(files, { level: 6 });
  return new Response(zip as unknown as BodyInit, {
    headers: { 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="ryadom-export-${new Date().toISOString().slice(0, 10)}.zip"`, 'Cache-Control': 'no-store' },
  });
});
