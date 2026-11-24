import 'server-only';
import type { LanguageModel } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { gateway } from '@ai-sdk/gateway';
import { serverEnv } from '@/lib/env';

export type ProviderId = 'chatgpt' | 'gateway' | 'openai' | 'workers-ai';
export type Task = 'agent' | 'strong' | 'vision' | 'parse' | 'compose';
export type ModelRef = { provider: ProviderId; model: string };

/**
 * Model routing per task. Order inside a provider list = preference; the provider order
 * itself comes from LLM_PROVIDER_ORDER (default: chatgpt, gateway, openai, workers-ai).
 * - agent: cheap/fast with solid tool calling and Russian
 * - strong: reviews, slip analysis, plans
 * - vision: food photo recognition (structured output)
 * - parse: text -> food items (structured output)
 * - compose: one-line notification texts
 */
export const ROUTES: Record<Task, Partial<Record<ProviderId, string[]>>> = {
  agent: {
    chatgpt: ['gpt-6-luna'],
    gateway: ['openai/gpt-6-luna', 'google/gemini-3.8-flash'],
    openai: ['gpt-6-luna'],
    'workers-ai': ['@cf/openai/gpt-oss-120b', '@cf/meta/llama-4-scout-17b-16e-instruct'],
  },
  strong: {
    chatgpt: ['gpt-6.1-sol'],
    gateway: ['openai/gpt-6.1-sol', 'google/gemini-3.1-pro-preview'],
    openai: ['gpt-6.1-sol'],
    'workers-ai': ['@cf/zai-org/glm-5.3', '@cf/openai/gpt-oss-120b'],
  },
  vision: {
    chatgpt: ['gpt-6.1-terra', 'gpt-6-luna'],
    gateway: ['google/gemini-3.8-flash', 'openai/gpt-6-luna'],
    openai: ['gpt-6.1-terra', 'gpt-6-luna'],
    // eval (Nutrition5k, 20 dishes): qwen3.8-27b MAE 109 kcal / MAPE 50% (~39 s);
    // mistral-small-3.1 MAE ~150 / MAPE ~82% (~15 s) — kept as the faster fallback.
    'workers-ai': ['@cf/qwen/qwen3.8-27b', '@cf/mistralai/mistral-small-3.1-24b-instruct'],
  },
  parse: {
    chatgpt: ['gpt-6-luna'],
    gateway: ['openai/gpt-6-luna', 'google/gemini-3.1-flash-lite'],
    openai: ['gpt-6-luna'],
    'workers-ai': ['@cf/mistralai/mistral-small-3.1-24b-instruct', '@cf/openai/gpt-oss-120b'],
  },
  compose: {
    chatgpt: ['gpt-6-luna'],
    gateway: ['openai/gpt-6-luna'],
    openai: ['gpt-6-luna'],
    'workers-ai': ['@cf/openai/gpt-oss-20b', '@cf/meta/llama-4-scout-17b-16e-instruct'],
  },
};

export type ProviderCtx = { chatgptAccessToken?: string | null };

export function providerConfigured(p: ProviderId, ctx: ProviderCtx = {}): boolean {
  const env = serverEnv();
  switch (p) {
    case 'chatgpt':
      return Boolean(ctx.chatgptAccessToken && process.env.CHATGPT_PLAN_ENABLED === '1');
    case 'gateway':
      return env.gatewayConfigured && process.env.LLM_DISABLE_GATEWAY !== '1';
    case 'openai':
      return Boolean(env.openaiApiKey);
    case 'workers-ai':
      return Boolean(env.cloudflareAccountId && env.cloudflareApiToken);
  }
}

type WireMessage = { role: string; content: unknown; tool_calls?: unknown[] };

/**
 * Workers AI's OpenAI-compatible endpoint validates messages more strictly than OpenAI:
 * assistant messages carrying tool_calls must have a string content ("" not null), and text-only content
 * must be a string (arrays are accepted only with images for vision models).
 */
export function normalizeWorkersAiBody(body: string): string {
  try {
    const b = JSON.parse(body) as { messages?: WireMessage[] };
    if (!Array.isArray(b.messages)) return body;
    b.messages = b.messages.map((m) => {
      if (m.role === 'assistant' && m.content == null) {
        return { ...m, content: '' };
      }
      if (Array.isArray(m.content)) {
        const parts = m.content as { type: string; text?: string }[];
        if (parts.every((p) => p.type === 'text')) return { ...m, content: parts.map((p) => p.text ?? '').join('\n') };
      }
      return m;
    });
    return JSON.stringify(b);
  } catch {
    return body;
  }
}

const workersAiFetch: typeof fetch = (input, init) => {
  if (init?.body && typeof init.body === 'string') {
    return fetch(input, { ...init, body: normalizeWorkersAiBody(init.body) });
  }
  return fetch(input, init);
};

export function workersAiBaseUrl(): string {
  return `https://api.cloudflare.com/client/v4/accounts/${serverEnv().cloudflareAccountId}/ai/v1`;
}

export function languageModel(ref: ModelRef, ctx: ProviderCtx = {}): LanguageModel {
  const env = serverEnv();
  switch (ref.provider) {
    case 'gateway':
      return gateway(ref.model);
    case 'openai':
      return createOpenAI({ apiKey: env.openaiApiKey })(ref.model);
    case 'chatgpt':
      // "Sign in with ChatGPT" plan usage (docs/research/chatgpt-oauth.md): the user's OAuth
      // access token is a bearer token for the Responses API; requests must be streamed with
      // store=false and without temperature/max_output_tokens (see llm/generate.ts).
      return createOpenAI({ apiKey: ctx.chatgptAccessToken ?? '' }).responses(ref.model);
    case 'workers-ai':
      return createOpenAICompatible({
        name: 'workers-ai',
        baseURL: workersAiBaseUrl(),
        apiKey: env.cloudflareApiToken,
        includeUsage: true,
        supportsStructuredOutputs: true,
        fetch: workersAiFetch,
      }).chatModel(ref.model);
  }
}

/** Ordered candidates for a task, filtered by configuration. */
export function candidates(task: Task, ctx: ProviderCtx = {}, only?: ProviderId[]): ModelRef[] {
  const order = (only ?? (serverEnv().providerOrder as ProviderId[])).filter((p) => p in ROUTES[task]);
  const out: ModelRef[] = [];
  for (const provider of order) {
    if (!providerConfigured(provider, ctx)) continue;
    for (const model of ROUTES[task][provider] ?? []) out.push({ provider, model });
  }
  return out;
}
