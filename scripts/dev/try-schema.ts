import { generateText, Output, NoObjectGeneratedError } from 'ai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { RecognitionOutput } from '@/lib/recognition/schema';
import { textSystemPrompt } from '@/lib/recognition/prompts';

const wa = createOpenAICompatible({ name: 'workers-ai', baseURL: `https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/ai/v1`, apiKey: process.env.CLOUDFLARE_API_TOKEN!, includeUsage: true, supportsStructuredOutputs: true });
for (const m of process.argv.slice(2)) {
  const t0 = Date.now();
  try {
    const r = await generateText({ model: wa.chatModel(m), instructions: textSystemPrompt(), messages: [{ role: 'user', content: 'Текст: «на обед у друзей съел тарелку плова и салат из помидоров с огурцами»' }], output: Output.object({ schema: RecognitionOutput }), maxRetries: 0, maxOutputTokens: 2500 });
    console.log('OK', m, Date.now() - t0, 'ms', JSON.stringify(r.output).slice(0, 400), r.usage.inputTokens, r.usage.outputTokens);
  } catch (e) {
    if (NoObjectGeneratedError.isInstance(e)) console.log('NOOBJ', m, String(e.text).slice(0, 600), '| finish:', e.finishReason, '| cause:', String((e.cause as Error)?.message).slice(0, 300));
    else console.log('ERR', m, (e as Error).message.slice(0, 300));
  }
}
