import { createClient } from '@supabase/supabase-js';
import { maybeReviewMemory } from '@/lib/agent/memory-review';

const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SECRET_KEY!, { auth: { persistSession: false } });
const { data: u } = await admin.from('profiles').select('user_id').limit(1).single();
const userId = u!.user_id as string;
const lines = ['по средам у меня пары до 18:00, обед получается только в 19', 'ок', 'рыбу я вообще не ем, даже если дешёвая', 'что на ужин?', 'спасибо', 'а если поздно вернусь?', 'понял', 'по средам опять буду поздно'];
const base = Date.now() - 60_000;
await admin.from('agent_messages').insert(lines.map((t, i) => ({ user_id: userId, role: 'user', kind: 'chat', text: t, parts: [], meta: {}, created_at: new Date(base + i * 1000).toISOString() })));
const n = await maybeReviewMemory(admin, userId);
const { data } = await admin.from('memories').select('kind, content, status').eq('user_id', userId).eq('status', 'proposed');
console.log('proposed:', n, JSON.stringify(data, null, 1));
