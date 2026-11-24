import 'server-only';
import { generateText, streamText, Output, type ModelMessage, type LanguageModel } from 'ai';
import type { z } from 'zod';
import { withFallback, type CallLog, type Attempt } from './router';
import type { ModelRef, ProviderCtx, ProviderId, Task } from './providers';

type GenArgs = {
  task: Task;
  log: CallLog;
  system: string;
  messages: ModelMessage[];
  ctx?: ProviderCtx;
  only?: ProviderId[];
  skip?: ModelRef[];
  prefer?: ModelRef;
  models?: ModelRef[];
  noBreaker?: boolean;
  timeoutMs?: number;
  temperature?: number;
  maxOutputTokens?: number;
};

function callSettings(ref: ModelRef, temperature?: number, maxOutputTokens = 2500) {
  // ChatGPT plan route rejects temperature/max_output_tokens and requires store=false.
  if (ref.provider === 'chatgpt') return { providerOptions: { openai: { store: false } } };
  return {
    ...(temperature != null ? { temperature } : {}),
    // Workers AI defaults to a tiny output budget; structured JSON gets truncated without this.
    maxOutputTokens,
    reasoning: 'low' as const,
  };
}

/** Structured output with provider fallback. */
export async function genObject<S extends z.ZodType>(args: GenArgs & { schema: S }): Promise<Attempt<z.infer<S>>> {
  return withFallback(args.task, args.log, async (model: LanguageModel, ref: ModelRef) => {
    const common = {
      model,
      instructions: args.system,
      messages: args.messages,
      output: Output.object({ schema: args.schema }),
      maxRetries: 0,
      timeout: args.timeoutMs ?? 45_000,
      ...callSettings(ref, args.temperature, args.maxOutputTokens),
    };
    if (ref.provider === 'chatgpt') {
      const res = streamText(common);
      const output = await res.output;
      const usage = await res.usage;
      return { value: output as z.infer<S>, usage };
    }
    const res = await generateText(common);
    return { value: res.output as z.infer<S>, usage: res.usage };
  }, { ctx: args.ctx, only: args.only, skip: args.skip, prefer: args.prefer, models: args.models, noBreaker: args.noBreaker });
}

/** Plain text with provider fallback. */
export async function genText(args: GenArgs): Promise<Attempt<string>> {
  return withFallback(args.task, args.log, async (model: LanguageModel, ref: ModelRef) => {
    const common = {
      model,
      instructions: args.system,
      messages: args.messages,
      maxRetries: 0,
      timeout: args.timeoutMs ?? 30_000,
      ...callSettings(ref, args.temperature, args.maxOutputTokens),
    };
    if (ref.provider === 'chatgpt') {
      const res = streamText(common);
      return { value: await res.text, usage: await res.usage };
    }
    const res = await generateText(common);
    return { value: res.text, usage: res.usage };
  }, { ctx: args.ctx, only: args.only, skip: args.skip, prefer: args.prefer, models: args.models, noBreaker: args.noBreaker });
}
