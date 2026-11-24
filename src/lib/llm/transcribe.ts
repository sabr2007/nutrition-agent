import 'server-only';
import { serverEnv } from '@/lib/env';
import { classifyError, LlmError, logLlmCall, type CallLog } from './router';

export type TranscriptResult = { text: string; model: string; latencyMs: number };

/**
 * Speech-to-text for the chat microphone. The ChatGPT plan route has no transcription and no
 * audio input (OpenAI excludes both explicitly, docs/research/chatgpt-oauth.md §3.1), so voice
 * notes are the one model call outside ChatGPT: Whisper on Cloudflare Workers AI, free within
 * the daily quota. Single engine, no fallback.
 */
const WHISPER = '@cf/openai/whisper-large-v3-turbo';
const TIMEOUT_MS = 45_000;
const STT_UNAVAILABLE = 'Расшифровка голоса сейчас недоступна. Напиши текстом.';

// Whisper fills silence with phrases from its training subtitles; treat them as nothing said.
const HALLUCINATION = /^(?:(?:продолжение следует|спасибо за (?:просмотр|внимание)|подписывайтесь на канал)[.!…\s]*|(?:субтитры|редактор субтитров)\s.*)$/i;

export function cleanTranscript(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return HALLUCINATION.test(t) ? '' : t;
}

export async function transcribeAudio(audio: Uint8Array, log: CallLog): Promise<TranscriptResult> {
  const env = serverEnv();
  if (!env.cloudflareAccountId || !env.cloudflareApiToken) throw new LlmError('not_connected', STT_UNAVAILABLE);
  const t0 = Date.now();
  try {
    const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.cloudflareAccountId}/ai/run/${WHISPER}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.cloudflareApiToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ audio: Buffer.from(audio).toString('base64'), language: 'ru', task: 'transcribe', vad_filter: true }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const body = (await res.json().catch(() => ({}))) as { success?: boolean; result?: { text?: string }; errors?: { message: string }[] };
    if (!res.ok || !body.success) {
      const err = new Error(body.errors?.map((e) => e.message).join('; ') || `whisper ${res.status}`) as Error & { statusCode?: number };
      err.statusCode = res.status;
      throw err;
    }
    const latencyMs = Date.now() - t0;
    void logLlmCall({ log, provider: 'workers-ai', model: WHISPER, status: 'ok', latencyMs });
    return { text: cleanTranscript(body.result?.text ?? ''), model: WHISPER, latencyMs };
  } catch (err) {
    const { cls, code, message } = classifyError(err);
    void logLlmCall({ log, provider: 'workers-ai', model: WHISPER, status: 'error', latencyMs: Date.now() - t0, errorCode: `${cls}:${code}`, error: message });
    throw new LlmError(cls, STT_UNAVAILABLE);
  }
}
