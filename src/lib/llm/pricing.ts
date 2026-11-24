// USD per 1M tokens (input, output). Sources: Vercel AI Gateway public catalog and
// Cloudflare Workers AI model catalog (both checked 2026-11-24). Used only for
// cost logging; update when prices change.
export const PRICES: Record<string, { in: number; out: number; perMinute?: number }> = {
  // OpenAI (direct API; ChatGPT plan has no marginal cost but we log list price)
  'gpt-6-luna': { in: 0.1, out: 0.5 },
  'gpt-6.1-terra': { in: 1, out: 5 },
  'gpt-6.1-sol': { in: 2, out: 10 },
  'gpt-transcribe': { in: 0, out: 0, perMinute: 0.0045 },
  'gpt-5.4': { in: 2.5, out: 15 },
  'gpt-5.4-mini': { in: 0.75, out: 4.5 },
  'gpt-5.4-nano': { in: 0.2, out: 1.25 },
  'gpt-5-mini': { in: 0.25, out: 2 },
  'gpt-5-nano': { in: 0.05, out: 0.4 },
  'gpt-4o-mini-transcribe': { in: 1.25, out: 5 },
  // Vercel AI Gateway ids
  'openai/gpt-6-luna': { in: 0.1, out: 0.5 },
  'openai/gpt-6.1-sol': { in: 2, out: 10 },
  'openai/gpt-transcribe': { in: 0, out: 0, perMinute: 0.0045 },
  'openai/gpt-5.4': { in: 2.5, out: 15 },
  'openai/gpt-5.4-mini': { in: 0.75, out: 4.5 },
  'openai/gpt-5.4-nano': { in: 0.2, out: 1.25 },
  'openai/gpt-5-mini': { in: 0.25, out: 2 },
  'google/gemini-3.8-flash': { in: 0.75, out: 3.75 },
  'google/gemini-3-flash': { in: 0.5, out: 3 },
  'google/gemini-3.1-flash-lite': { in: 0.25, out: 1.5 },
  'google/gemini-3.1-pro-preview': { in: 2, out: 12 },
  'openai/gpt-4o-mini-transcribe': { in: 1.25, out: 5 },
  // Cloudflare Workers AI
  '@cf/meta/llama-4-scout-17b-16e-instruct': { in: 0.27, out: 0.85 },
  '@cf/mistralai/mistral-small-3.1-24b-instruct': { in: 0.351, out: 0.555 },
  '@cf/openai/gpt-oss-120b': { in: 0.35, out: 0.75 },
  '@cf/openai/gpt-oss-20b': { in: 0.2, out: 0.3 },
  '@cf/zai-org/glm-4.7-flash': { in: 0.0605, out: 0.4 },
  '@cf/zai-org/glm-5.3': { in: 1.4, out: 4.4 },
  '@cf/qwen/qwen3.8-27b': { in: 0.45, out: 3.2 },
  '@cf/openai/whisper-large-v3-turbo': { in: 0, out: 0, perMinute: 0.000513 },
};

export function costUsd(model: string, tokensIn = 0, tokensOut = 0): number {
  const p = PRICES[model];
  if (!p) return 0;
  return Number(((tokensIn * p.in + tokensOut * p.out) / 1_000_000).toFixed(6));
}
