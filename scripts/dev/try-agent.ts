import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';
import { runAgent } from '@/lib/agent/run';

// Acts as the real user (JWT) so RLS and auth.uid() behave like in the app.
const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anon = createClient(url, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!, { auth: { persistSession: false } });
const [email, passFile, ...texts] = process.argv.slice(2);
const { data, error } = await anon.auth.signInWithPassword({ email, password: readFileSync(passFile, 'utf8').trim() });
if (error) throw error;
const sb = createClient(url, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!, { auth: { persistSession: false }, global: { headers: { Authorization: `Bearer ${data.session!.access_token}` } } });
for (const text of texts) {
  const r = await runAgent({ sb, userId: data.user!.id, trigger: 'chat', userText: text });
  console.log(`\n> ${text}\n[${r.provider}/${r.model} ${r.latencyMs}ms ${r.decision}] tools: ${r.toolCalls.map((t) => t.tool + (t.error ? '(ERR ' + t.error.slice(0, 80) + ')' : '')).join(' → ') || '-'}\n${r.text}`);
  if (r.ui.choices) console.log('  buttons:', r.ui.choices.options.join(' | '));
  if (r.ui.proposedMemories.length) console.log('  memory?:', r.ui.proposedMemories.map((m) => m.content).join(' / '));
  if (r.ui.pendingActions.length) console.log('  confirm:', r.ui.pendingActions.map((a) => a.summary).join(' / '));
}
