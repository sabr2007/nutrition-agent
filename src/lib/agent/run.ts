import 'server-only';
import { generateText, streamText, isStepCount, type ModelMessage, type ToolSet } from 'ai';
import { getChatgptToken } from '@/lib/llm/chatgpt';
import type { SupabaseClient } from '@supabase/supabase-js';
import { withFallback } from '@/lib/llm/router';
import { costUsd } from '@/lib/llm/pricing';
import { getProfile } from '@/lib/data/profile';
import { getDaySummary } from '@/lib/data/day';
import { localParts } from '@/lib/nutrition/day';
import { buildTools, emptyUi, type AgentUi, type ToolCtx } from './tools';
import { AGENT_PROMPT_VERSION, buildSystemPrompt, loadMemory, loadSkillsIndex } from './context';
import { isFoodReport, matchSkill, safetySignals } from './skills-router';

export type AgentTrigger = ToolCtx['trigger'];

export type AgentResult = {
  runId: string;
  text: string;
  ui: AgentUi;
  decision: 'answered' | 'sent' | 'silent' | 'error';
  model: string | null;
  provider: string | null;
  toolCalls: TraceCall[];
  latencyMs: number;
  messageId: string | null;
};

export type TraceCall = { step: number; tool: string; input: unknown; output_preview: string; error?: string };

const MAX_STEPS = 8;
const HISTORY = 16;

async function loadHistory(sb: SupabaseClient, userId: string): Promise<ModelMessage[]> {
  const { data } = await sb.from('agent_messages').select('role, text, kind, created_at').eq('user_id', userId).eq('thread', 'main')
    .order('created_at', { ascending: false }).limit(HISTORY);
  return (data ?? []).reverse().filter((m) => m.text).map((m) => ({
    role: m.role === 'user' ? 'user' : 'assistant',
    content: m.kind === 'proactive' ? `[проактивное сообщение] ${m.text}` : (m.text as string),
  })) as ModelMessage[];
}

function preview(v: unknown): string {
  try {
    const s = JSON.stringify(v);
    return s.length > 600 ? `${s.slice(0, 600)}…` : s;
  } catch {
    return String(v).slice(0, 600);
  }
}

export async function runAgent(opts: {
  sb: SupabaseClient;
  userId: string;
  trigger: AgentTrigger;
  userText?: string;
  skillKey?: string | null;
  proactive?: { reason: string; ruleKey?: string | null; template?: string | null; sentToday: number; lastSentAt?: string | null };
  dryRun?: boolean;
  persist?: boolean;
  history?: ModelMessage[];
  /** Simulated clock (tests/evals of proactive wakes); defaults to now. */
  now?: Date;
}): Promise<AgentResult> {
  const t0 = Date.now();
  const { sb, userId } = opts;
  const persist = opts.persist ?? true;
  const profile = await getProfile(sb, userId);
  const runId = crypto.randomUUID();
  const mode = opts.trigger === 'chat' || opts.trigger === 'eval' ? 'chat' : 'proactive';

  if (persist) {
    await sb.from('agent_runs').insert({ id: runId, user_id: userId, trigger: opts.trigger, skill_key: opts.skillKey ?? matchSkill(opts.userText) ?? null, status: 'running', input: { text: opts.userText?.slice(0, 2000) ?? null, proactive: opts.proactive ?? null, prompt_version: AGENT_PROMPT_VERSION } });
  }

  const [summary, memory, skills, history] = await Promise.all([
    getDaySummary(sb, userId, undefined, profile),
    loadMemory(sb, userId, opts.userText),
    loadSkillsIndex(sb, userId),
    opts.history ? Promise.resolve(opts.history) : persist ? loadHistory(sb, userId) : Promise.resolve([] as ModelMessage[]),
  ]);
  // Pre-load the procedure for obvious intents (or an explicitly requested skill).
  const activeSkillKey = opts.skillKey ?? (mode === 'chat' ? matchSkill(opts.userText) : 'proactive_checkin');
  let activeSkill: { key: string; body: string } | null = null;
  if (activeSkillKey) {
    const { data } = await sb.from('skills').select('key, body, user_id').eq('key', activeSkillKey).eq('is_current', true).eq('status', 'active')
      .or(`user_id.is.null,user_id.eq.${userId}`).order('user_id', { ascending: false, nullsFirst: false }).limit(1);
    if (data?.[0]) activeSkill = { key: data[0].key as string, body: data[0].body as string };
  }
  const since14 = new Date(Date.now() - 14 * 86_400_000).toISOString();
  const { count: slips14 } = await sb.from('slips').select('id', { count: 'exact', head: true }).eq('user_id', userId).gte('occurred_at', since14);
  const safety = mode === 'chat' ? safetySignals(opts.userText, slips14 ?? 0) : { binge: false, reason: null };
  const system = buildSystemPrompt({ profile, summary, memory, skills, mode, proactive: opts.proactive, activeSkill, safety, now: opts.now, foodReport: mode === 'chat' && isFoodReport(opts.userText) });
  const messages: ModelMessage[] = [...history];
  if (opts.userText) messages.push({ role: 'user', content: opts.userText });
  if (!messages.length || messages[messages.length - 1].role !== 'user') {
    messages.push({ role: 'user', content: mode === 'proactive' ? '[планировщик] Проверь контекст и реши, писать ли сейчас.' : 'Продолжай.' });
  }

  const chatgptAccessToken = await getChatgptToken(userId).catch(() => null);
  let ui = emptyUi();
  let trace: TraceCall[] = [];
  let usageIn = 0;
  let usageOut = 0;
  try {
    const attempt = await withFallback('agent', { userId, runId, purpose: mode === 'chat' ? 'agent_chat' : 'agent_proactive' }, async (model, ref) => {
      ui = emptyUi();
      trace = [];
      const baseTools = buildTools({ sb, userId, profile, runId, trigger: opts.trigger, ui, dryRun: opts.dryRun });
      const isPlan = ref.provider === 'chatgpt';
      // ChatGPT plan route: function tools must be grouped in a namespace; requests must stream.
      const tools: ToolSet = isPlan
        ? Object.fromEntries(Object.entries(baseTools).map(([k, t]) => [k, { ...t, providerOptions: { openai: { namespace: { name: 'ryadom', description: 'Nutrition coach tools' } } } }])) as ToolSet
        : baseTools;
      const common = {
        model, instructions: system, messages, tools, stopWhen: isStepCount(MAX_STEPS), maxRetries: 0, timeout: 90_000,
        ...(isPlan ? { providerOptions: { openai: { store: false } } } : { maxOutputTokens: 1800, reasoning: 'low' as const, temperature: 0.4 }),
      };
      const res = isPlan
        ? await (async () => { const st = streamText(common); return { steps: await st.steps, text: await st.text, usage: await st.usage }; })()
        : await generateText(common);
      res.steps.forEach((step, i) => {
        for (const call of step.toolCalls) {
          const result = step.toolResults.find((r) => r.toolCallId === call.toolCallId);
          const errPart = (step.content as { type: string; toolCallId?: string; error?: unknown }[])
            .find((p) => p.type === 'tool-error' && p.toolCallId === call.toolCallId);
          trace.push({
            step: i, tool: call.toolName, input: call.input, output_preview: preview(result?.output),
            ...(errPart ? { error: String((errPart.error as Error)?.message ?? errPart.error).slice(0, 300) } : {}),
          });
        }
      });
      return { value: res, usage: res.usage };
    }, { ctx: { chatgptAccessToken } });
    usageIn = attempt.usage?.inputTokens ?? 0;
    usageOut = attempt.usage?.outputTokens ?? 0;
    const raw = attempt.result.text.trim();
    let decision: AgentResult['decision'] = 'answered';
    let text = raw;
    if (mode === 'proactive') {
      decision = ui.sentMessages.length ? 'sent' : 'silent';
      text = ui.sentMessages[0] ?? raw;
    } else if (!text) {
      text = ui.loggedMeals.length ? `Записал: ${ui.loggedMeals.map((m) => `${m.title} — ${m.kcal} ккал, белок ${m.protein_g} г`).join('; ')}.` : 'Готово.';
    }

    let messageId: string | null = null;
    if (persist) {
      const rows: Record<string, unknown>[] = [];
      // PostgREST bulk inserts require identical keys in every row.
      // Explicit timestamps: both rows share one transaction, so now() would tie and break ordering.
      if (opts.userText && opts.trigger === 'chat') rows.push({ user_id: userId, role: 'user', kind: 'chat', text: opts.userText, parts: [{ type: 'text', text: opts.userText }], run_id: runId, meta: {}, created_at: new Date(t0).toISOString() });
      if (mode === 'chat' || decision === 'sent') {
        rows.push({
          user_id: userId, role: 'assistant', kind: mode === 'chat' ? 'chat' : 'proactive', text,
          parts: [{ type: 'text', text }], run_id: runId,
          meta: { choices: ui.choices ?? null, proposed_memories: ui.proposedMemories, pending_actions: ui.pendingActions, logged_meals: ui.loggedMeals, model: attempt.ref.model },
          created_at: new Date(Math.max(Date.now(), t0 + 1)).toISOString(),
        });
      }
      if (rows.length) {
        const { data, error: msgErr } = await sb.from('agent_messages').insert(rows).select('id, role');
        if (msgErr) console.error('[agent] message persist failed', msgErr.code, msgErr.message.slice(0, 200));
        messageId = (data ?? []).find((r) => r.role === 'assistant')?.id ?? null;
      }
      await sb.from('agent_runs').update({
        status: 'ok', decision, provider: attempt.ref.provider, model: attempt.ref.model, finished_at: new Date().toISOString(),
        latency_ms: Date.now() - t0, steps: new Set(trace.map((t) => t.step)).size, tool_calls: trace, tokens_in: usageIn, tokens_out: usageOut,
        cost_usd: costUsd(attempt.ref.model, usageIn, usageOut), output_text: raw.slice(0, 4000),
      }).eq('id', runId);
    }
    return { runId, text, ui, decision, model: attempt.ref.model, provider: attempt.ref.provider, toolCalls: trace, latencyMs: Date.now() - t0, messageId };
  } catch (err) {
    const message = (err as Error).message?.slice(0, 500);
    if (persist) {
      await sb.from('agent_runs').update({ status: 'error', error: message, finished_at: new Date().toISOString(), latency_ms: Date.now() - t0, tool_calls: trace }).eq('id', runId);
    }
    return {
      runId, ui, decision: 'error', model: null, provider: null, toolCalls: trace, latencyMs: Date.now() - t0, messageId: null,
      text: 'Сейчас не получается связаться с моделью. Запись еды шаблонами и вручную работает — попробуй спросить чуть позже.',
    };
  }
}

export function nowLocal(tz: string): string {
  return localParts(new Date(), tz).hhmm;
}
