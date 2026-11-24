import { generateText, isStepCount } from 'ai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { createClient } from '@supabase/supabase-js';
import { buildTools, emptyUi } from '@/lib/agent/tools';
import { getProfile } from '@/lib/data/profile';
import { normalizeWorkersAiBody } from '@/lib/llm/providers';

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SECRET_KEY!, { auth: { persistSession: false } });
const userId = process.argv[2];
const only = process.argv[3];
const profile = await getProfile(sb, userId);
const wa = createOpenAICompatible({
  name: 'workers-ai', baseURL: `https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/ai/v1`, apiKey: process.env.CLOUDFLARE_API_TOKEN!, includeUsage: true,
  fetch: async (url, init) => {
    const res = await fetch(url, { ...init, body: normalizeWorkersAiBody(String(init?.body)) });
    if (!res.ok) { const t = await res.clone().text(); console.log('HTTP', res.status, t.slice(0, 500)); const b = JSON.parse(String(init?.body)); console.log('tools:', b.tools?.length, 'keys:', Object.keys(b).join(',')); console.log(JSON.stringify(JSON.parse(normalizeWorkersAiBody(String(init?.body))).messages).slice(0, 1500)); }
    return res;
  },
});
const all = buildTools({ sb, userId, profile, runId: 'dbg', trigger: 'chat', ui: emptyUi(), dryRun: true });
const tools = only ? Object.fromEntries(Object.entries(all).filter(([k]) => only.split(',').includes(k))) : all;
try {
  const r = await generateText({ model: wa.chatModel('@cf/openai/gpt-oss-120b'), instructions: 'Ты коуч. Используй инструменты.', messages: [{ role: 'user', content: 'Сколько я съел сегодня?' }], tools, stopWhen: isStepCount(3), maxRetries: 0, maxOutputTokens: 800 });
  console.log('OK', r.steps.flatMap((s) => s.toolCalls.map((c) => c.toolName)), r.text.slice(0, 200));
} catch (e) { console.log('ERR', (e as Error).message.slice(0, 200)); }
