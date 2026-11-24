import 'server-only';
import type { LanguageModel } from 'ai';
import { candidates, languageModel, type ModelRef, type ProviderCtx, type ProviderId, type Task } from './providers';
import { costUsd } from './pricing';
import { supabaseAdmin } from '@/lib/supabase/server';

// Circuit breaker per provider (per server instance): after quota/auth errors we skip a
// provider for a while instead of paying its latency on every request.
const openUntil = new Map<string, number>();

export type CallLog = {
  userId?: string | null;
  runId?: string | null;
  recognitionId?: string | null;
  purpose: string;
};

export type Usage = { inputTokens?: number; outputTokens?: number };

export type ErrorClass = 'quota' | 'auth' | 'rate' | 'server' | 'bad_request' | 'timeout' | 'unknown';

export function classifyError(err: unknown): { cls: ErrorClass; code: string; message: string } {
  const e = err as { statusCode?: number; status?: number; name?: string; message?: string; data?: unknown; responseBody?: string };
  const status = e?.statusCode ?? e?.status;
  // Provider error bodies explain 400s (e.g. unsupported parameter); keep a short snippet.
  const body = typeof e?.responseBody === 'string' ? ` | ${e.responseBody.slice(0, 300)}` : '';
  const msg = `${String(e?.message ?? err)}${body}`.slice(0, 600);
  const lower = msg.toLowerCase();
  if (/credit card|insufficient_quota|quota|usage limit|limit reached|billing|weekly limit|exceeded/.test(lower)) return { cls: 'quota', code: String(status ?? 'quota'), message: msg };
  if (status === 401 || status === 403 || /unauthori[sz]ed|forbidden|invalid api key|authentication/.test(lower)) return { cls: 'auth', code: String(status ?? 'auth'), message: msg };
  if (status === 429 || /rate limit|too many requests/.test(lower)) return { cls: 'rate', code: '429', message: msg };
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError' || /timeout|timed out/.test(lower)) return { cls: 'timeout', code: 'timeout', message: msg };
  if (status && status >= 500) return { cls: 'server', code: String(status), message: msg };
  if (status && status >= 400) return { cls: 'bad_request', code: String(status), message: msg };
  return { cls: 'unknown', code: e?.name ?? 'error', message: msg };
}

const COOLDOWN_MS: Record<ErrorClass, number> = {
  quota: 30 * 60_000,
  auth: 10 * 60_000,
  rate: 60_000,
  server: 30_000,
  timeout: 15_000,
  bad_request: 0,
  unknown: 10_000,
};

// Provider-level problems (quota, auth, outages) skip the whole provider; model-level
// problems (bad output, unsupported params) skip only that model.
const PROVIDER_LEVEL: ErrorClass[] = ['quota', 'auth', 'rate', 'server'];

function circuitOpen(p: ProviderId, model?: string): boolean {
  const now = Date.now();
  const providerUntil = openUntil.get(p);
  const modelUntil = model ? openUntil.get(`${p}/${model}`) : undefined;
  return Boolean((providerUntil && providerUntil > now) || (modelUntil && modelUntil > now));
}

export async function logLlmCall(row: {
  log: CallLog; ref: ModelRef; status: 'ok' | 'error'; usage?: Usage; latencyMs: number;
  errorCode?: string; error?: string; fallbackFrom?: string | null;
}): Promise<void> {
  try {
    await supabaseAdmin().from('llm_calls').insert({
      user_id: row.log.userId ?? null,
      run_id: row.log.runId ?? null,
      recognition_id: row.log.recognitionId ?? null,
      purpose: row.log.purpose,
      provider: row.ref.provider,
      model: row.ref.model,
      status: row.status,
      error_code: row.errorCode ?? null,
      error: row.error?.slice(0, 500) ?? null,
      fallback_from: row.fallbackFrom ?? null,
      tokens_in: row.usage?.inputTokens ?? null,
      tokens_out: row.usage?.outputTokens ?? null,
      cost_usd: costUsd(row.ref.model, row.usage?.inputTokens, row.usage?.outputTokens),
      latency_ms: row.latencyMs,
    });
  } catch {
    // logging must never break the request
  }
}

export type Attempt<T> = { result: T; ref: ModelRef; latencyMs: number; usage?: Usage; fallbackFrom: string | null };

/**
 * Runs `fn` against the first healthy model for the task, falling back on errors.
 * `fn` must return { value, usage }.
 */
export async function withFallback<T>(
  task: Task,
  log: CallLog,
  fn: (model: LanguageModel, ref: ModelRef) => Promise<{ value: T; usage?: Usage }>,
  opts: { ctx?: ProviderCtx; only?: ProviderId[]; maxAttempts?: number; skip?: ModelRef[]; prefer?: ModelRef; models?: ModelRef[]; noBreaker?: boolean } = {},
): Promise<Attempt<T>> {
  // An explicit model list (evals, experiments) replaces the task routes.
  let list = (opts.models ?? candidates(task, opts.ctx, opts.only)).filter(
    (c) => !opts.skip?.some((s) => s.model === c.model && s.provider === c.provider),
  );
  if (opts.prefer) {
    const i = list.findIndex((c) => c.model === opts.prefer!.model && c.provider === opts.prefer!.provider);
    if (i > 0) list = [list[i], ...list.slice(0, i), ...list.slice(i + 1)];
  }
  const errors: string[] = [];
  let fallbackFrom: string | null = null;
  let attempts = 0;
  for (const ref of list) {
    if (!opts.noBreaker && circuitOpen(ref.provider, ref.model)) continue;
    if (opts.maxAttempts && attempts >= opts.maxAttempts) break;
    attempts++;
    const t0 = Date.now();
    try {
      const { value, usage } = await fn(languageModel(ref, opts.ctx), ref);
      const latencyMs = Date.now() - t0;
      void logLlmCall({ log, ref, status: 'ok', usage, latencyMs, fallbackFrom });
      return { result: value, ref, latencyMs, usage, fallbackFrom };
    } catch (err) {
      const latencyMs = Date.now() - t0;
      const { cls, code, message } = classifyError(err);
      void logLlmCall({ log, ref, status: 'error', latencyMs, errorCode: `${cls}:${code}`, error: message, fallbackFrom });
      if (!opts.noBreaker && COOLDOWN_MS[cls] > 0) {
        const key = PROVIDER_LEVEL.includes(cls) ? ref.provider : `${ref.provider}/${ref.model}`;
        openUntil.set(key, Date.now() + COOLDOWN_MS[cls]);
      }
      errors.push(`${ref.provider}/${ref.model}: ${cls}`);
      fallbackFrom = `${ref.provider}/${ref.model}`;
    }
  }
  const err = new Error(`Все LLM-провайдеры недоступны (${errors.join('; ') || 'не настроены'})`);
  err.name = 'NoProviderAvailable';
  throw err;
}

/** True while a provider is cooling down after quota/auth/server errors. */
export function providerHealthy(p: ProviderId): boolean {
  return !circuitOpen(p);
}

export function providerStatus(ctx: ProviderCtx = {}) {
  const tasks: Task[] = ['agent', 'vision', 'parse', 'strong', 'compose'];
  return Object.fromEntries(
    tasks.map((t) => [t, candidates(t, ctx).map((c) => ({ ...c, open: circuitOpen(c.provider, c.model) }))]),
  );
}
