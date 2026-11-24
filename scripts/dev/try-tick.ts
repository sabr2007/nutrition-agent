import { createClient } from '@supabase/supabase-js';
import { runTick } from '@/lib/reminders/engine';

// Simulated tick at a given local time (Asia/Almaty, UTC+5) on today's local date.
const hhmm = process.argv[2] ?? '21:05';
const day = process.argv[3] ?? new Date(Date.now() + 5 * 3600_000 - 4 * 3600_000).toISOString().slice(0, 10);
const [h, m] = hhmm.split(':').map(Number);
const at = new Date(Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10)), h - 5, m));
if (h < 4) at.setUTCDate(at.getUTCDate() + 1);
const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SECRET_KEY!, { auth: { persistSession: false } });
const reports = await runTick(admin, at);
for (const r of reports) {
  console.log(`tick @ ${hhmm} (${at.toISOString()}): sent=[${r.sent.join(', ')}] errors=${r.errors.length ? r.errors.join(' | ') : 0}`);
  console.log('skipped:', JSON.stringify(r.skipped));
}
const { data } = await admin.from('notifications').select('rule_key, status, body, suppression_reason').order('created_at', { ascending: false }).limit(5);
for (const n of data ?? []) console.log(`  [${n.status}] ${n.rule_key}: ${n.body}${n.suppression_reason ? ' (' + n.suppression_reason + ')' : ''}`);
