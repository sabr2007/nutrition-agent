import 'server-only';
import { streamText, Output, type ModelMessage } from 'ai';
import type { z } from 'zod';
import { callModel, type Attempt, type CallLog } from './router';
import { MODELS, planOptions, type Task } from './models';

type GenArgs = {
  task: Exclude<Task, 'agent' | 'deep'>;
  log: CallLog;
  system: string;
  messages: ModelMessage[];
  timeoutMs?: number;
};

const DEFAULT_TIMEOUT_MS = 60_000;

// The plan route only answers streamed requests, so even one-shot calls use streamText.

/** Structured output (JSON schema) from the task's model. */
export async function genObject<S extends z.ZodType>(args: GenArgs & { schema: S }): Promise<Attempt<z.infer<S>>> {
  const spec = MODELS[args.task];
  return callModel(spec, args.log, async (model) => {
    const res = streamText({
      model,
      instructions: args.system,
      messages: args.messages,
      output: Output.object({ schema: args.schema }),
      maxRetries: 0,
      timeout: args.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      providerOptions: planOptions(spec),
    });
    const value = (await res.output) as z.infer<S>;
    return { value, usage: await res.usage };
  });
}

/** Plain text from the task's model. */
export async function genText(args: GenArgs): Promise<Attempt<string>> {
  const spec = MODELS[args.task];
  return callModel(spec, args.log, async (model) => {
    const res = streamText({
      model,
      instructions: args.system,
      messages: args.messages,
      maxRetries: 0,
      timeout: args.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      providerOptions: planOptions(spec),
    });
    return { value: await res.text, usage: await res.usage };
  });
}
