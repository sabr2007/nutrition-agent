import 'server-only';
import { isStepCount, streamText, type ModelMessage, type StepResult, type ToolSet } from 'ai';
import { openai } from '@ai-sdk/openai';
import type { SupabaseClient } from '@supabase/supabase-js';
import { callModel, userMessageFor } from '@/lib/llm/router';
import { agentSpec, planOptions } from '@/lib/llm/models';
import { costUsd } from '@/lib/llm/pricing';
import { getProfile, type Profile } from '@/lib/data/profile';
import { getDaySummary } from '@/lib/data/day';
import { localParts } from '@/lib/nutrition/day';
import { historyText, toolLabel, type ChatEvent, type ChatPart } from '@/lib/chat/protocol';
import { buildTools, emptyUi, type AgentUi, type ToolCtx } from './tools';
import { AGENT_PROMPT_VERSION, buildSystemPrompt, loadMemory, loadSkillsIndex } from './context';
import { isCorrection, isFoodReport, matchSkill, safetySignals, statesCalories } from './skills-router';
import { newDryWorld, overlayDay, type DryWorld } from './dry-world';

export type AgentTrigger = ToolCtx['trigger'];

export type AgentResult = {
  runId: string;
  text: string;
  ui: AgentUi;
  decision: 'answered' | 'sent' | 'silent' | 'error';
  model: string | null;
  toolCalls: TraceCall[];
  latencyMs: number;
  messageId: string | null;
  userMessageId: string | null;
};

export type TraceCall = { step: number; tool: string; input: unknown; output_preview: string; error?: string };

/** A photo attached to the user's chat message (already stored in the private bucket). */
export type AgentImage = { mediaId: string; path: string; data: Uint8Array; mime: string };

export type AgentOptions = {
  sb: SupabaseClient;
  userId: string;
  trigger: AgentTrigger;
  userText?: string;
  images?: AgentImage[];
  /** «Думать дольше»: the stronger model with more reasoning. */
  deep?: boolean;
  /** Where the reply is shown: the app's chat or Telegram (formatting rules differ). */
  channel?: 'app' | 'telegram';
  /** Evals only: run on this model instead of the configured one. */
  modelOverride?: string | null;
  skillKey?: string | null;
  proactive?: { reason: string; ruleKey?: string | null; template?: string | null; sentToday: number; lastSentAt?: string | null };
  dryRun?: boolean;
  /** Simulated foods/meals of a dry run (evals with a fixture); created when absent. */
  dryWorld?: DryWorld;
  persist?: boolean;
  history?: ModelMessage[];
  /** Simulated clock (tests/evals of proactive wakes); defaults to now. */
  now?: Date;
  /** Live progress for the chat stream: tool activity and text deltas. */
  onEvent?: (e: ChatEvent) => void;
};

const MAX_STEPS = 10;
const HISTORY = 16;
const RUN_TIMEOUT_MS = 90_000;
const DEEP_TIMEOUT_MS = 240_000;
const PREVIEW_CHARS = 600;
const SLIP_WINDOW_MS = 14 * 86_400_000;
const NAMESPACE = { name: 'ryadom', description: 'Nutrition coach tools: food log, body metrics, checklist, memory, plans' };

async function loadHistory(sb: SupabaseClient, userId: string): Promise<ModelMessage[]> {
  const { data } = await sb.from('agent_messages').select('role, text, kind, parts, created_at').eq('user_id', userId).eq('thread', 'main')
    .order('created_at', { ascending: false }).limit(HISTORY);
  return (data ?? []).reverse()
    .map((m) => ({ role: m.role as string, kind: m.kind as string, text: historyText((m.text as string) ?? '', m.parts as ChatPart[]) }))
    .filter((m) => m.text)
    .map((m) => ({
      role: m.role === 'user' ? 'user' : 'assistant',
      content: m.kind === 'proactive' ? `[проактивное сообщение] ${m.text}` : m.text,
    })) as ModelMessage[];
}

function preview(v: unknown): string {
  try {
    const s = JSON.stringify(v);
    return s.length > PREVIEW_CHARS ? `${s.slice(0, PREVIEW_CHARS)}…` : s;
  } catch {
    return String(v).slice(0, PREVIEW_CHARS);
  }
}

/** The plan route wants function tools grouped in a namespace (docs/research/chatgpt-oauth.md). */
function namespaced(tools: ToolSet): ToolSet {
  return Object.fromEntries(Object.entries(tools).map(([k, t]) => [k, { ...t, providerOptions: { openai: { namespace: NAMESPACE } } }])) as ToolSet;
}

/** Models whose built-in web search was verified on the plan (self-check probe, D26). */
const WEB_SEARCH_MODELS = new Set((process.env.WEB_SEARCH_MODELS ?? 'gpt-6.1-sol,gpt-6.2-sol').split(',').map((m) => m.trim()).filter(Boolean));

/** Function tools in the plan's namespace, plus the built-in web search for conversations (D26). */
function agentTools(ctx: ToolCtx, mode: 'chat' | 'proactive', model: string): ToolSet {
  const tools = namespaced(buildTools(ctx));
  return mode === 'chat' && WEB_SEARCH_MODELS.has(model) ? { ...tools, web_search: openai.tools.webSearch({ searchContextSize: 'medium' }) } : tools;
}

function userContent(text: string, images: AgentImage[]): ModelMessage['content'] {
  if (!images.length) return text;
  return [
    { type: 'text', text: text || 'Фото без подписи.' },
    ...images.map((img) => ({ type: 'file' as const, mediaType: img.mime || 'image/jpeg', data: img.data })),
  ];
}

function traceSteps(steps: StepResult<ToolSet>[]): TraceCall[] {
  return steps.flatMap((step, i) => step.toolCalls.map((call) => {
    const result = step.toolResults.find((r) => r.toolCallId === call.toolCallId);
    const errPart = (step.content as { type: string; toolCallId?: string; error?: unknown }[])
      .find((p) => p.type === 'tool-error' && p.toolCallId === call.toolCallId);
    return {
      step: i, tool: call.toolName, input: call.input, output_preview: preview(result?.output),
      ...(errPart ? { error: String((errPart.error as Error)?.message ?? errPart.error).slice(0, 300) } : {}),
    };
  }));
}

/** A reply made of what the tools did, when the model said nothing (or failed after writing). */
function writesSummary(ui: AgentUi): string | null {
  if (ui.loggedMeals.length) return `Записал: ${ui.loggedMeals.map((m) => `${m.title} — ${m.kcal} ккал, белок ${m.protein_g} г`).join('; ')}.`;
  if (ui.actions.length) return ui.actions.map((a) => a.text).join('\n');
  return null;
}

type Prepared = { profile: Profile; system: string; messages: ModelMessage[]; mode: 'chat' | 'proactive' };

async function prepare(opts: AgentOptions, userText: string, images: AgentImage[], persist: boolean, dry?: DryWorld): Promise<Prepared> {
  const { sb, userId } = opts;
  const profile = await getProfile(sb, userId);
  const mode = opts.trigger === 'chat' || opts.trigger === 'eval' ? 'chat' : 'proactive';
  const [summary, memory, skills, history] = await Promise.all([
    getDaySummary(sb, userId, undefined, profile).then((s) => overlayDay(s, dry)),
    loadMemory(sb, userId, userText),
    loadSkillsIndex(sb, userId),
    opts.history ? Promise.resolve(opts.history) : persist ? loadHistory(sb, userId) : Promise.resolve([] as ModelMessage[]),
  ]);
  // Pre-load the procedure for obvious intents (or an explicitly requested skill).
  const activeSkillKey = opts.skillKey ?? (mode === 'chat' ? matchSkill(userText) : 'proactive_checkin');
  let activeSkill: { key: string; body: string } | null = null;
  if (activeSkillKey) {
    const { data } = await sb.from('skills').select('key, body, user_id').eq('key', activeSkillKey).eq('is_current', true).eq('status', 'active')
      .or(`user_id.is.null,user_id.eq.${userId}`).order('user_id', { ascending: false, nullsFirst: false }).limit(1);
    if (data?.[0]) activeSkill = { key: data[0].key as string, body: data[0].body as string };
  }
  const { count: slips14 } = await sb.from('slips').select('id', { count: 'exact', head: true }).eq('user_id', userId)
    .gte('occurred_at', new Date(Date.now() - SLIP_WINDOW_MS).toISOString());
  const safety = mode === 'chat' ? safetySignals(userText, slips14 ?? 0) : { binge: false, reason: null };
  const system = buildSystemPrompt({
    profile, summary, memory, skills, mode, proactive: opts.proactive, activeSkill, safety, now: opts.now,
    foodReport: mode === 'chat' && isFoodReport(userText), photos: images.length,
    correction: mode === 'chat' && isCorrection(userText), statedKcal: mode === 'chat' && statesCalories(userText),
    channel: opts.channel ?? 'app',
  });
  const messages: ModelMessage[] = [...history];
  if (userText || images.length) messages.push({ role: 'user', content: userContent(userText, images) } as ModelMessage);
  if (!messages.length || messages[messages.length - 1].role !== 'user') {
    messages.push({ role: 'user', content: mode === 'proactive' ? '[планировщик] Проверь контекст и реши, писать ли сейчас.' : 'Продолжай.' });
  }
  return { profile, system, messages, mode };
}

/** Saves the user turn (with photo parts) and the reply; returns their ids. */
async function persistTurn(opts: AgentOptions, a: {
  runId: string; t0: number; userText: string; images: AgentImage[]; text: string; ui: AgentUi; model: string | null; withReply: boolean;
}): Promise<{ messageId: string | null; userMessageId: string | null }> {
  const rows: Record<string, unknown>[] = [];
  // PostgREST bulk inserts require identical keys in every row.
  // Explicit timestamps: both rows share one transaction, so now() would tie and break ordering.
  if ((a.userText || a.images.length) && opts.trigger === 'chat') {
    const parts: ChatPart[] = [
      ...a.images.map((i) => ({ type: 'image' as const, media_id: i.mediaId, path: i.path })),
      ...(a.userText ? [{ type: 'text' as const, text: a.userText }] : []),
    ];
    rows.push({ user_id: opts.userId, role: 'user', kind: 'chat', text: a.userText, parts, run_id: a.runId, meta: { channel: opts.channel ?? 'app' }, created_at: new Date(a.t0).toISOString() });
  }
  if (a.withReply) {
    rows.push({
      user_id: opts.userId, role: 'assistant', kind: opts.trigger === 'chat' || opts.trigger === 'eval' ? 'chat' : 'proactive', text: a.text,
      parts: [{ type: 'text', text: a.text }], run_id: a.runId,
      meta: {
        choices: a.ui.choices ?? null, proposed_memories: a.ui.proposedMemories, pending_actions: a.ui.pendingActions,
        logged_meals: a.ui.loggedMeals, actions: a.ui.actions, model: a.model, deep: Boolean(opts.deep), channel: opts.channel ?? 'app',
      },
      created_at: new Date(Math.max(Date.now(), a.t0 + 1)).toISOString(),
    });
  }
  if (!rows.length) return { messageId: null, userMessageId: null };
  const { data, error } = await opts.sb.from('agent_messages').insert(rows).select('id, role');
  if (error) console.error('[agent] message persist failed', error.code, error.message.slice(0, 200));
  return {
    messageId: (data ?? []).find((r) => r.role === 'assistant')?.id ?? null,
    userMessageId: (data ?? []).find((r) => r.role === 'user')?.id ?? null,
  };
}

export async function runAgent(opts: AgentOptions): Promise<AgentResult> {
  const t0 = Date.now();
  const { sb, userId } = opts;
  const persist = opts.persist ?? true;
  const images = opts.images ?? [];
  const userText = opts.userText?.trim() ?? '';
  const runId = crypto.randomUUID();
  const chatTurn = opts.trigger === 'chat' || opts.trigger === 'eval';
  // Plain food logging («съел 200 г гречки», no question, no photo) runs on low effort.

  if (persist) {
    await sb.from('agent_runs').insert({
      id: runId, user_id: userId, trigger: opts.trigger, skill_key: opts.skillKey ?? matchSkill(userText) ?? null, status: 'running',
      input: { text: userText.slice(0, 2000) || null, media_ids: images.map((i) => i.mediaId), deep: Boolean(opts.deep), proactive: opts.proactive ?? null, prompt_version: AGENT_PROMPT_VERSION },
    });
  }

  const dry = opts.dryRun ? (opts.dryWorld ?? newDryWorld()) : undefined;
  const { profile, system, messages, mode } = await prepare(opts, userText, images, persist, dry);
  // Plain food logging («съел 200 г гречки», no question, no photo) runs on low effort. The model:
  // eval override → profiles.settings.agent_model (instant) → AGENT_MODEL env → default.
  const simpleLog = chatTurn && !images.length && isFoodReport(userText) && !userText.includes('?');
  const settingsModel = typeof profile.settings.agent_model === 'string' && /^[a-z0-9.\-]{3,40}$/.test(profile.settings.agent_model) ? profile.settings.agent_model : null;
  const spec = agentSpec({ deep: chatTurn && opts.deep, simpleLog, model: opts.modelOverride ?? settingsModel });
  const ui = emptyUi();
  let trace: TraceCall[] = [];
  const toolCtx: ToolCtx = {
    sb, userId, profile, runId, trigger: opts.trigger, ui, dryRun: opts.dryRun, dry,
    photo: images.length ? { mediaIds: images.map((i) => i.mediaId), model: spec.model } : undefined,
  };
  const purpose = mode === 'chat' ? (opts.deep ? 'agent_chat_deep' : 'agent_chat') : 'agent_proactive';
  try {
    const attempt = await callModel(spec, { userId, runId, purpose }, async (model) => {
      const st = streamText({
        model, instructions: system, messages, tools: agentTools(toolCtx, mode, spec.model), stopWhen: isStepCount(MAX_STEPS),
        // The last allowed step must be the reply: a run that spends every step on tools ends mute.
        prepareStep: ({ stepNumber }) => (stepNumber >= MAX_STEPS - 1 ? { toolChoice: 'none' as const } : undefined),
        maxRetries: 0, timeout: opts.deep ? DEEP_TIMEOUT_MS : RUN_TIMEOUT_MS, providerOptions: planOptions(spec),
        onChunk: ({ chunk }) => {
          if (!opts.onEvent) return;
          if (chunk.type === 'text-delta') opts.onEvent({ t: 'text', d: chunk.text });
          else if (chunk.type === 'tool-input-start') opts.onEvent({ t: 'tool', name: chunk.toolName, label: toolLabel(chunk.toolName) });
        },
      });
      const [steps, text, usage] = await Promise.all([st.steps, st.text, st.usage]);
      trace = traceSteps(steps);
      return { value: { text, steps: steps.length }, usage };
    });
    const raw = attempt.result.text.trim();
    let decision: AgentResult['decision'] = 'answered';
    let text = raw;
    if (mode === 'proactive') {
      decision = ui.sentMessages.length ? 'sent' : 'silent';
      text = ui.sentMessages[0] ?? raw;
    } else if (!text) {
      text = writesSummary(ui) ?? 'Готово.';
    }
    let ids = { messageId: null as string | null, userMessageId: null as string | null };
    if (persist) {
      ids = await persistTurn(opts, { runId, t0, userText, images, text, ui, model: attempt.model, withReply: mode === 'chat' || decision === 'sent' });
      const tokensIn = attempt.usage?.inputTokens ?? 0;
      const tokensOut = attempt.usage?.outputTokens ?? 0;
      await sb.from('agent_runs').update({
        status: 'ok', decision, provider: 'chatgpt', model: attempt.model, finished_at: new Date().toISOString(),
        latency_ms: Date.now() - t0, steps: attempt.result.steps, tool_calls: trace, tokens_in: tokensIn, tokens_out: tokensOut,
        cost_usd: costUsd(attempt.model, tokensIn, tokensOut), output_text: raw.slice(0, 4000),
      }).eq('id', runId);
    }
    return { runId, text, ui, decision, model: attempt.model, toolCalls: trace, latencyMs: Date.now() - t0, ...ids };
  } catch (err) {
    const message = (err as Error).message?.slice(0, 500);
    // Tools may have written data before the model failed: keep the turn so the chat matches the day.
    const partial = chatTurn ? writesSummary(ui) : null;
    let ids = { messageId: null as string | null, userMessageId: null as string | null };
    if (persist) {
      if (partial) ids = await persistTurn(opts, { runId, t0, userText, images, text: partial, ui, model: spec.model, withReply: true });
      await sb.from('agent_runs').update({ status: 'error', error: message, finished_at: new Date().toISOString(), latency_ms: Date.now() - t0, tool_calls: trace }).eq('id', runId);
    }
    if (partial) return { runId, text: partial, ui, decision: 'answered', model: spec.model, toolCalls: trace, latencyMs: Date.now() - t0, ...ids };
    return { runId, ui, decision: 'error', model: null, toolCalls: trace, latencyMs: Date.now() - t0, messageId: null, userMessageId: null, text: userMessageFor(err) };
  }
}

export function nowLocal(tz: string): string {
  return localParts(new Date(), tz).hhmm;
}
