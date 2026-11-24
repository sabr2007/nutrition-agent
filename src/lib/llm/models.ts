import 'server-only';
import type { LanguageModel } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';

/**
 * Every model call goes to the owner's ChatGPT plan ("Sign in with ChatGPT",
 * docs/research/chatgpt-oauth.md): one model per task, no other providers and no fallback.
 * The only exception is speech-to-text (llm/transcribe.ts): the plan route has no audio.
 */
export type Task = 'agent' | 'deep' | 'vision' | 'parse' | 'compose';
export type Effort = 'low' | 'medium' | 'high';
export type ModelSpec = { model: string; effort: Effort };

export const MODELS: Record<Task, ModelSpec> = {
  /** Chat and proactive check-ins: fast, solid tool calling and Russian. */
  agent: { model: 'gpt-6-luna', effort: 'low' },
  /** «Думать дольше» in the chat: plans, weekly reviews, hard questions. */
  deep: { model: 'gpt-6.1-sol', effort: 'high' },
  /** Food photos and nutrition labels on the log screen (structured output). */
  vision: { model: 'gpt-6.1-terra', effort: 'low' },
  /** Free text → food items on the log screen. */
  parse: { model: 'gpt-6-luna', effort: 'low' },
  /** Push texts and the background memory review. */
  compose: { model: 'gpt-6-luna', effort: 'low' },
};

/** The owner's OAuth access token is a bearer token for the Responses API. */
export function chatgptModel(token: string, model: string): LanguageModel {
  return createOpenAI({ apiKey: token }).responses(model);
}

/**
 * Plan-route request options: `store: false` is mandatory; temperature and max output tokens
 * are rejected by the route, so reasoning effort is the only knob we turn.
 */
export function planOptions(spec: ModelSpec) {
  return { openai: { store: false, reasoningEffort: spec.effort, reasoningSummary: null } };
}
