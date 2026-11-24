import 'server-only';
import { transcribe } from 'ai';
import { gateway } from '@ai-sdk/gateway';
import { createOpenAI } from '@ai-sdk/openai';
import { serverEnv } from '@/lib/env';
import { classifyError, logLlmCall, type CallLog } from './router';

export type TranscriptResult = { text: string; provider: string; model: string; latencyMs: number };

type Engine = { provider: string; model: string; run: (audio: Uint8Array, mime: string) => Promise<string> };

function engines(): Engine[] {
  const env = serverEnv();
  const list: Engine[] = [];
  const order = env.providerOrder;
  const add: Record<string, () => void> = {
    gateway: () => {
      if (!env.gatewayConfigured || process.env.LLM_DISABLE_GATEWAY === '1') return;
      list.push({
        provider: 'gateway', model: 'openai/gpt-transcribe',
        run: async (audio) => (await transcribe({ model: gateway.transcriptionModel('openai/gpt-transcribe'), audio, providerOptions: { openai: { language: 'ru' } } })).text,
      });
    },
    openai: () => {
      if (!env.openaiApiKey) return;
      list.push({
        provider: 'openai', model: 'gpt-transcribe',
        run: async (audio) => (await transcribe({ model: createOpenAI({ apiKey: env.openaiApiKey }).transcription('gpt-transcribe'), audio, providerOptions: { openai: { language: 'ru' } } })).text,
      });
    },
    'workers-ai': () => {
      if (!env.cloudflareAccountId || !env.cloudflareApiToken) return;
      list.push({
        provider: 'workers-ai', model: '@cf/openai/whisper-large-v3-turbo',
        run: async (audio) => {
          const res = await fetch(
            `https://api.cloudflare.com/client/v4/accounts/${env.cloudflareAccountId}/ai/run/@cf/openai/whisper-large-v3-turbo`,
            {
              method: 'POST',
              headers: { Authorization: `Bearer ${env.cloudflareApiToken}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({ audio: Buffer.from(audio).toString('base64'), language: 'ru', task: 'transcribe', vad_filter: true }),
              signal: AbortSignal.timeout(45_000),
            },
          );
          const body = (await res.json()) as { success?: boolean; result?: { text?: string }; errors?: { message: string }[] };
          if (!res.ok || !body.success) {
            const err = new Error(body.errors?.map((e) => e.message).join('; ') || `workers-ai ${res.status}`) as Error & { statusCode?: number };
            err.statusCode = res.status;
            throw err;
          }
          return body.result?.text?.trim() ?? '';
        },
      });
    },
  };
  for (const p of order) add[p]?.();
  return list;
}

export async function transcribeAudio(audio: Uint8Array, mime: string, log: CallLog): Promise<TranscriptResult> {
  const errors: string[] = [];
  let fallbackFrom: string | null = null;
  for (const e of engines()) {
    const t0 = Date.now();
    const ref = { provider: e.provider as never, model: e.model };
    try {
      const text = await e.run(audio, mime);
      const latencyMs = Date.now() - t0;
      void logLlmCall({ log, ref, status: 'ok', latencyMs, fallbackFrom });
      return { text, provider: e.provider, model: e.model, latencyMs };
    } catch (err) {
      const { cls, code, message } = classifyError(err);
      void logLlmCall({ log, ref, status: 'error', latencyMs: Date.now() - t0, errorCode: `${cls}:${code}`, error: message, fallbackFrom });
      errors.push(`${e.provider}: ${cls}`);
      fallbackFrom = `${e.provider}/${e.model}`;
    }
  }
  throw new Error(`Транскрипция недоступна (${errors.join('; ') || 'нет провайдеров'})`);
}
