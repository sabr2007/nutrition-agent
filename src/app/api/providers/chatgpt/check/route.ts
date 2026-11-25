import { createOpenAI } from '@ai-sdk/openai';
import { isStepCount, Output, streamText, tool, type ModelMessage } from 'ai';
import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import { isCronRequest } from '@/lib/cron-auth';
import { handler, HttpError, json, requireUser } from '@/lib/http';
import { rateLimit } from '@/lib/ratelimit';
import { getChatgptToken } from '@/lib/llm/chatgpt';
import { classifyError } from '@/lib/llm/router';
import { supabaseAdmin } from '@/lib/supabase/server';
import { runAgent } from '@/lib/agent/run';
import { checkScenario, scenarioHistory, scenarioWorld, SCENARIOS } from '@/lib/agent/scenarios';

// 15 scenarios × up to ~40 s each, three at a time.
export const maxDuration = 300;

// Self-check of the ChatGPT plan route: the account's model catalog, tiny probes of every
// capability the app relies on (text, reasoning effort, structured output, namespaced tools,
// image input) and, on request, the agent eval scenarios in dry-run (nothing is written).
// Callable by the owner or with the cron secret; returns no tokens.
const DEFAULT_MODELS = ['gpt-6-luna', 'gpt-6.1-terra', 'gpt-6.1-sol'];
const WEB_SEARCH_PROMPT = 'Найди в интернете калорийность холодного чая Fuse Tea (лимон) на 100 мл. Ответь одной строкой: число ккал и адрес страницы.';
const PROBE_TIMEOUT_MS = 60_000;
const OUT_PREVIEW = 120;
const ERR_PREVIEW = 300;
// 32×32 solid red PNG.
const RED_PNG = 'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAKklEQVR42mO4IydHU8QwasGoBaMWjFowasGoBaMWjFowasGoBaMWDBULAJI2YD30P/0LAAAAAElFTkSuQmCC';

const SCENARIO_CONCURRENCY = 3;

const Body = z.object({
  models: z.array(z.string().regex(/^[a-z0-9.\-]+$/)).max(6).optional(),
  probes: z.boolean().default(true),
  agent: z.boolean().default(false),
  /** Run only these scenario ids. */
  scenarios: z.array(z.string().max(40)).max(40).optional(),
  /** Run the agent scenarios on this model (before/after a model switch). */
  agent_model: z.string().regex(/^[a-z0-9.\-]+$/).max(40).optional(),
}).default({ probes: true, agent: false });

type Probe = { ok: boolean; ms: number; out?: string; error?: string };

async function probe(run: () => Promise<string>): Promise<Probe> {
  const t0 = Date.now();
  try {
    const out = await run();
    return { ok: true, ms: Date.now() - t0, out: out.slice(0, OUT_PREVIEW) };
  } catch (err) {
    const { cls, code, message } = classifyError(err);
    return { ok: false, ms: Date.now() - t0, error: `${cls}:${code} ${message}`.slice(0, ERR_PREVIEW) };
  }
}

async function resolveUser(req: Request): Promise<{ userId: string; sb: SupabaseClient }> {
  if (!isCronRequest(req)) {
    const { userId, sb } = await requireUser(req);
    return { userId, sb };
  }
  const admin = supabaseAdmin();
  const { data } = await admin.from('provider_connections').select('user_id').eq('provider', 'chatgpt').eq('status', 'connected').limit(1);
  const userId = data?.[0]?.user_id as string | undefined;
  if (!userId) throw new HttpError(404, 'ChatGPT не подключён', 'not_connected');
  return { userId, sb: admin };
}

/** Agent eval scenarios on the real prompt and data, write tools simulated. */
async function runScenarios(sb: SupabaseClient, userId: string, only?: string[], model?: string) {
  const out: { id: string; pass: boolean; fails: string[]; tools: string[]; ms: number; reply: string; model: string | null }[] = [];
  const selected = only?.length ? SCENARIOS.filter((s) => only.includes(s.id)) : SCENARIOS;
  for (let i = 0; i < selected.length; i += SCENARIO_CONCURRENCY) {
    const batch = selected.slice(i, i + SCENARIO_CONCURRENCY);
    const worlds = batch.map((s) => scenarioWorld(s));
    const runs = await Promise.all(batch.map((s, j) => runAgent({
      sb, userId, trigger: 'eval', userText: s.prompt, dryRun: true, dryWorld: worlds[j], persist: false, history: scenarioHistory(s), modelOverride: model ?? null,
    })));
    batch.forEach((s, j) => {
      const r = runs[j];
      const tools = r.toolCalls.map((t) => t.tool);
      const fails = checkScenario(s, { tools, text: r.text, error: r.decision === 'error', effects: worlds[j].effects, choices: Boolean(r.ui.choices) });
      out.push({ id: s.id, pass: !fails.length, fails, tools, ms: r.latencyMs, reply: r.text.slice(0, OUT_PREVIEW * 2), model: r.model });
    });
  }
  return { passed: out.filter((r) => r.pass).length, total: out.length, results: out };
}

async function catalog(token: string): Promise<unknown> {
  const res = await fetch('https://api.openai.com/v1/models', { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) });
  const body = (await res.json().catch(() => null)) as { models?: Record<string, unknown>[]; data?: Record<string, unknown>[] } | null;
  const rows = body?.models ?? body?.data ?? [];
  return {
    status: res.status,
    models: rows.slice(0, 40).map((m) => ({ slug: m.slug ?? m.id, name: m.display_name ?? null, visibility: m.visibility ?? null })),
  };
}

function probesFor(token: string, slug: string): Record<string, Promise<Probe>> {
  const provider = createOpenAI({ apiKey: token });
  const model = provider.responses(slug);
  const openaiTools = provider.tools;
  const base = { model, maxRetries: 0, timeout: PROBE_TIMEOUT_MS };
  const plain = { openai: { store: false } };
  const image: ModelMessage[] = [{
    role: 'user',
    content: [
      { type: 'text', text: 'Какого цвета квадрат на картинке? Ответь одним словом.' },
      { type: 'file', mediaType: 'image/png', data: Buffer.from(RED_PNG, 'base64') },
    ],
  }];
  const ping = tool({
    description: 'Doubles a number.',
    inputSchema: z.object({ n: z.number() }),
    execute: async ({ n }) => ({ doubled: n * 2 }),
    providerOptions: { openai: { namespace: { name: 'probe', description: 'Probe tools' } } },
  });
  return {
    text: probe(async () => streamText({ ...base, instructions: 'Отвечай одним словом.', prompt: 'Скажи: ок', providerOptions: plain }).text),
    reasoning_low: probe(async () => streamText({ ...base, prompt: 'Сколько будет 2+2? Только число.', providerOptions: { openai: { store: false, reasoningEffort: 'low', reasoningSummary: null } } }).text),
    reasoning_high: probe(async () => streamText({ ...base, prompt: 'Сколько будет 17*3? Только число.', providerOptions: { openai: { store: false, reasoningEffort: 'high', reasoningSummary: null } } }).text),
    json: probe(async () => JSON.stringify(await streamText({ ...base, prompt: 'Назови цвет неба днём.', output: Output.object({ schema: z.object({ color: z.string() }) }), providerOptions: plain }).output)),
    tools: probe(async () => {
      const st = streamText({ ...base, prompt: 'Вызови инструмент ping с n=21 и назови результат одним числом.', tools: { ping }, stopWhen: isStepCount(3), providerOptions: plain });
      const steps = await st.steps;
      const calls = steps.flatMap((s) => s.toolCalls.map((c) => c.toolName)).join(',');
      return `calls=[${calls}] text=${(await st.text).trim()}`;
    }),
    vision: probe(async () => streamText({ ...base, messages: image, providerOptions: plain }).text),
    // Built-in web search on the plan route (depends on the model and the account's policy).
    web_search: probe(async () => {
      const st = streamText({
        ...base, prompt: WEB_SEARCH_PROMPT, tools: { web_search: openaiTools.webSearch({ searchContextSize: 'low' }) },
        stopWhen: isStepCount(4), providerOptions: { openai: { store: false, reasoningEffort: 'low', reasoningSummary: null } },
      });
      const steps = await st.steps;
      const searches = steps.flatMap((x) => x.toolCalls).filter((c) => c.toolName === 'web_search').length;
      const sources = (await st.sources).length;
      return `searches=${searches} sources=${sources} text=${(await st.text).trim().slice(0, 120)}`;
    }),
    // The agent's last allowed step forbids tools so the run always ends with a reply.
    tool_choice_none: probe(async () => {
      const st = streamText({ ...base, prompt: 'Вызови ping с n=21, если можешь, иначе ответь словом «нет».', tools: { ping }, toolChoice: 'none', providerOptions: plain });
      const steps = await st.steps;
      return `calls=${steps.flatMap((x) => x.toolCalls).length} text=${(await st.text).trim()}`;
    }),
  };
}

export const POST = handler(async (req) => {
  const { userId, sb } = await resolveUser(req);
  // Each check spends plan quota (up to ~30 small calls): a few per hour is plenty.
  rateLimit(`chatgpt-check:${userId}`, 6, 60 * 60_000);
  const parsed = Body.safeParse(await req.json().catch(() => undefined));
  if (!parsed.success) throw new HttpError(400, 'Некорректный запрос', 'validation');
  const { probes, agent, scenarios, agent_model: agentModel } = parsed.data;
  const models = parsed.data.models?.length ? parsed.data.models : DEFAULT_MODELS;
  const token = await getChatgptToken(userId);
  if (!token) return json({ connected: false });
  const results: Record<string, Record<string, Probe>> = {};
  if (probes) {
    for (const slug of models) {
      const pending = probesFor(token, slug);
      const keys = Object.keys(pending);
      const settled = await Promise.all(keys.map((k) => pending[k]));
      results[slug] = Object.fromEntries(keys.map((k, i) => [k, settled[i]]));
    }
  }
  return json({
    connected: true,
    catalog: probes ? await catalog(token) : null,
    results,
    agent: agent ? await runScenarios(sb, userId, scenarios, agentModel) : null,
  });
});
