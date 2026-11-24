import 'server-only';
import type { LanguageModel } from 'ai';
import { supabaseAdmin } from '@/lib/supabase/server';
import { getChatgptToken } from './chatgpt';
import { chatgptModel, type ModelSpec } from './models';
import { costUsd } from './pricing';

export type CallLog = {
  userId: string;
  runId?: string | null;
  recognitionId?: string | null;
  purpose: string;
};

export type Usage = { inputTokens?: number; outputTokens?: number };

export type ErrorClass = 'not_connected' | 'quota' | 'auth' | 'rate' | 'server' | 'bad_request' | 'timeout' | 'unknown';

/** What the person sees when ChatGPT does not answer. There is no other provider to try. */
const USER_MESSAGE: Record<ErrorClass, string> = {
  not_connected: 'ChatGPT не подключён — нужно войти заново (команда в docs/SETUP.md). Шаблоны и ручная запись работают.',
  auth: 'ChatGPT не принял вход — нужно войти заново (команда в docs/SETUP.md). Шаблоны и ручная запись работают.',
  quota: 'Лимит подписки ChatGPT сейчас исчерпан. Шаблоны и ручная запись работают.',
  rate: 'ChatGPT просит подождать минуту. Попробуй ещё раз чуть позже.',
  server: 'ChatGPT сейчас не отвечает. Попробуй ещё раз через минуту.',
  timeout: 'ChatGPT думал слишком долго. Попробуй ещё раз.',
  bad_request: 'ChatGPT отклонил запрос. Попробуй сформулировать иначе.',
  unknown: 'Не получилось связаться с ChatGPT. Попробуй ещё раз.',
};

/** A failed model call, with a message that is safe to show in the UI. */
export class LlmError extends Error {
  constructor(public cls: ErrorClass, message = USER_MESSAGE[cls]) {
    super(message);
    this.name = 'LlmError';
  }
}

export function userMessageFor(err: unknown): string {
  return err instanceof LlmError ? err.message : USER_MESSAGE.unknown;
}

export function classifyError(err: unknown): { cls: ErrorClass; code: string; message: string } {
  const e = err as { statusCode?: number; status?: number; name?: string; message?: string; responseBody?: string };
  const status = e?.statusCode ?? e?.status;
  // Provider error bodies explain 400s (e.g. an unsupported parameter); keep a short snippet.
  const body = typeof e?.responseBody === 'string' ? ` | ${e.responseBody.slice(0, 300)}` : '';
  const msg = `${String(e?.message ?? err)}${body}`.slice(0, 600);
  const lower = msg.toLowerCase();
  if (/usage_limit|insufficient_quota|quota|usage limit|limit reached|weekly limit|billing/.test(lower)) return { cls: 'quota', code: String(status ?? 'quota'), message: msg };
  if (status === 401 || status === 403 || /unauthori[sz]ed|forbidden|invalid api key|authentication|token_expired|invalid_token/.test(lower)) return { cls: 'auth', code: String(status ?? 'auth'), message: msg };
  if (status === 429 || /rate limit|too many requests/.test(lower)) return { cls: 'rate', code: '429', message: msg };
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError' || /timeout|timed out/.test(lower)) return { cls: 'timeout', code: 'timeout', message: msg };
  if (status && status >= 500) return { cls: 'server', code: String(status), message: msg };
  if (status && status >= 400) return { cls: 'bad_request', code: String(status), message: msg };
  return { cls: 'unknown', code: e?.name ?? 'error', message: msg };
}

export async function logLlmCall(row: {
  log: CallLog; provider?: string; model: string; status: 'ok' | 'error'; usage?: Usage; latencyMs: number; errorCode?: string; error?: string;
}): Promise<void> {
  try {
    await supabaseAdmin().from('llm_calls').insert({
      user_id: row.log.userId,
      run_id: row.log.runId ?? null,
      recognition_id: row.log.recognitionId ?? null,
      purpose: row.log.purpose,
      provider: row.provider ?? 'chatgpt',
      model: row.model,
      status: row.status,
      error_code: row.errorCode ?? null,
      error: row.error?.slice(0, 500) ?? null,
      tokens_in: row.usage?.inputTokens ?? null,
      tokens_out: row.usage?.outputTokens ?? null,
      cost_usd: costUsd(row.model, row.usage?.inputTokens, row.usage?.outputTokens),
      latency_ms: row.latencyMs,
    });
  } catch {
    // logging must never break the request
  }
}

export type Attempt<T> = { result: T; model: string; latencyMs: number; usage?: Usage };

/**
 * Runs one model call on the ChatGPT plan and logs it. No retries and no fallback: a failure
 * becomes an LlmError with a message the UI can show as is.
 */
export async function callModel<T>(
  spec: ModelSpec,
  log: CallLog,
  fn: (model: LanguageModel) => Promise<{ value: T; usage?: Usage }>,
): Promise<Attempt<T>> {
  const token = await getChatgptToken(log.userId).catch(() => null);
  if (!token) {
    void logLlmCall({ log, model: spec.model, status: 'error', latencyMs: 0, errorCode: 'not_connected', error: 'no ChatGPT token' });
    throw new LlmError('not_connected');
  }
  const t0 = Date.now();
  try {
    const { value, usage } = await fn(chatgptModel(token, spec.model));
    const latencyMs = Date.now() - t0;
    void logLlmCall({ log, model: spec.model, status: 'ok', usage, latencyMs });
    return { result: value, model: spec.model, latencyMs, usage };
  } catch (err) {
    const { cls, code, message } = classifyError(err);
    void logLlmCall({ log, model: spec.model, status: 'error', latencyMs: Date.now() - t0, errorCode: `${cls}:${code}`, error: message });
    throw new LlmError(cls);
  }
}
