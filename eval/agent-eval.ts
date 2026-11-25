/**
 * Agent evals: scenario prompts → checks on tool calls and safety rules (section 2 of the spec).
 * Runs as a real user (JWT, RLS) in dry-run mode: write tools are simulated, nothing persisted.
 * The agent runs on the ChatGPT plan, so the target database needs a ChatGPT connection; for
 * production use POST /api/providers/chatgpt/check with {"agent": true} instead.
 *
 *   TSX_TSCONFIG_PATH=tsconfig.scripts.json node --conditions=react-server --env-file=.env.local \
 *     --import tsx eval/agent-eval.ts <email> <password-file>
 */
import { createClient } from '@supabase/supabase-js';
import { appendFileSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { runAgent } from '@/lib/agent/run';
import { AGENT_PROMPT_VERSION } from '@/lib/agent/context';
import { checkScenario, scenarioHistory, scenarioWorld, SCENARIOS } from '@/lib/agent/scenarios';

async function main() {
  const [email, passFile] = process.argv.slice(2);
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!;
  const anon = createClient(url, key, { auth: { persistSession: false } });
  const { data, error } = await anon.auth.signInWithPassword({ email, password: readFileSync(passFile, 'utf8').trim() });
  if (error) throw error;
  const sb = createClient(url, key, { auth: { persistSession: false }, global: { headers: { Authorization: `Bearer ${data.session!.access_token}` } } });
  const results = [];
  for (const s of SCENARIOS) {
    const world = scenarioWorld(s);
    const r = await runAgent({ sb, userId: data.user!.id, trigger: 'eval', userText: s.prompt, dryRun: true, dryWorld: world, persist: false, history: scenarioHistory(s) });
    const tools = r.toolCalls.map((t) => t.tool);
    const fails = checkScenario(s, { tools, text: r.text, error: r.decision === 'error', effects: world.effects, choices: Boolean(r.ui.choices) });
    results.push({ id: s.id, pass: fails.length === 0, fails, tools, model: r.model, latencyMs: r.latencyMs, reply: r.text.slice(0, 500) });
    console.log(`${fails.length ? '✗' : '✓'} ${s.id} [${tools.join(' → ') || '-'}] ${r.latencyMs}ms ${fails.join('; ')}`);
  }
  const passed = results.filter((r) => r.pass).length;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  mkdirSync('eval/results', { recursive: true });
  writeFileSync(`eval/results/${stamp}-agent.json`, JSON.stringify({ prompt_version: AGENT_PROMPT_VERSION, passed, total: results.length, results }, null, 2));
  const doc = path.join(process.cwd(), 'docs/research/agent-evals.md');
  if (!existsSync(doc)) writeFileSync(doc, `# Evals агента\n\nСценарии и проверки: \`src/lib/agent/scenarios.ts\` (dry-run: записи симулируются, правила безопасности из раздела 2 проверяются регулярками по ответу). Сырые ответы — \`eval/results/*-agent.json\`.\n\n| дата | промпт | модель | пройдено | провалы |\n|---|---|---|---|---|\n`);
  const models = [...new Set(results.map((r) => r.model).filter(Boolean))].join(', ');
  appendFileSync(doc, `| ${new Date().toISOString().slice(0, 16)} | ${AGENT_PROMPT_VERSION} | ${models} | ${passed}/${results.length} | ${results.filter((r) => !r.pass).map((r) => `${r.id}: ${r.fails.join(', ')}`).join('; ') || '—'} |\n`);
  console.log(`\n${passed}/${results.length} passed`);
}

main().catch((e) => { console.error(e); process.exit(1); });
