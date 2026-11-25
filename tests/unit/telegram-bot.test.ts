import { beforeEach, describe, expect, test } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { AgentOptions, AgentResult } from '@/lib/agent/run';
import type { BotApi } from '@/lib/telegram/bot';
import { TelegramError } from '@/lib/telegram/bot';
import { markKeyboard } from '@/lib/telegram/callbacks';
import { codeHash, REFUSAL } from '@/lib/telegram/pairing';
import { handleStranger } from '@/lib/telegram/pairing';
import type { CallbackRow, ChatState, NewUpdate, Owner, StoredUpdate, TgStore } from '@/lib/telegram/store';
import { runTurn, type TurnDeps } from '@/lib/telegram/turn';
import type { InlineKeyboard, TgUpdate } from '@/lib/telegram/types';
import { bestPhoto, classify } from '@/lib/telegram/update';
import { handleWebhook, secretMatches, type WebhookDeps } from '@/lib/telegram/webhook';
import { processChat, type WorkerDeps } from '@/lib/telegram/worker';
import { GAVE_UP_NOTICE, RETRY_NOTICE } from '@/lib/telegram/texts';

// Integration of webhook → queue → worker → turn → Bot API with an in-memory store and a
// recording Bot API: what is stored, what is sent, and what the agent receives.

const SECRET = 'test_secret-123';
const CODE = 'pair-me-42';
const OWNER_TG = 1001;
const STRANGER_TG = 2002;
const USER = '00000000-0000-4000-8000-000000000001';

class MemoryStore implements TgStore {
  updates = new Map<number, StoredUpdate>();
  chats = new Map<number, ChatState & { lease?: { holder: string; until: number } }>();
  profile: { userId: string; telegramUserId: number | null; chatId: number | null } = { userId: USER, telegramUserId: null, chatId: null };
  pairings = new Set<string>();
  callbacks = new Map<string, CallbackRow & { used: boolean }>();
  async findOwnerByTelegram(id: number): Promise<Owner | null> {
    return this.profile.telegramUserId === id ? { userId: this.profile.userId, telegramUserId: id, chatId: this.profile.chatId } : null;
  }
  async insertUpdate(row: NewUpdate) {
    if (this.updates.has(row.update_id)) return false;
    this.updates.set(row.update_id, { update_id: row.update_id, chat_id: row.chat_id ?? 0, user_id: row.user_id, kind: row.kind, media_group_id: row.media_group_id ?? null, payload: row.payload as TgUpdate, status: row.status, attempts: 0, received_at: new Date(Date.now() - 10_000).toISOString() });
    return true;
  }
  private chat(id: number) {
    if (!this.chats.has(id)) this.chats.set(id, { deepNext: false, mutedUntil: null, lastRefusalAt: null });
    return this.chats.get(id)!;
  }
  async acquireChat(chatId: number, holder: string, seconds: number) {
    const c = this.chat(chatId);
    if (c.lease && c.lease.until > Date.now() && c.lease.holder !== holder) return false;
    c.lease = { holder, until: Date.now() + seconds * 1000 };
    return true;
  }
  async releaseChat(chatId: number, holder: string) {
    const c = this.chat(chatId);
    if (c.lease?.holder === holder) c.lease = undefined;
  }
  private claim(u: StoredUpdate) {
    u.status = 'processing';
    u.attempts += 1;
    return u;
  }
  async claimNext(chatId: number) {
    const next = [...this.updates.values()].filter((u) => u.chat_id === chatId && u.status === 'received').sort((a, b) => a.update_id - b.update_id)[0];
    return next ? this.claim(next) : null;
  }
  async claimGroup(chatId: number, group: string) {
    return [...this.updates.values()].filter((u) => u.chat_id === chatId && u.media_group_id === group && u.status === 'received').map((u) => this.claim(u));
  }
  async latestGroupArrival(chatId: number, group: string) {
    return [...this.updates.values()].filter((u) => u.chat_id === chatId && u.media_group_id === group).map((u) => u.received_at).sort().pop() ?? null;
  }
  async hasWaiting(chatId: number) {
    return [...this.updates.values()].some((u) => u.chat_id === chatId && u.status === 'received');
  }
  async finishUpdate(id: number, r: { status: 'done' | 'failed'; error?: string }) {
    const u = this.updates.get(id)!;
    u.status = r.status;
  }
  async chatState(chatId: number) {
    const { deepNext, mutedUntil, lastRefusalAt } = this.chat(chatId);
    return { deepNext, mutedUntil, lastRefusalAt };
  }
  async setChatState(chatId: number, patch: Partial<ChatState>) {
    Object.assign(this.chat(chatId), patch);
  }
  async pairingUsed(h: string) { return this.pairings.has(h); }
  async ownerProfile() { return { userId: this.profile.userId, telegramUserId: this.profile.telegramUserId }; }
  async linkTelegram(userId: string, tg: number, chatId: number, h: string) {
    this.pairings.add(h);
    this.profile = { userId, telegramUserId: tg, chatId };
  }
  async saveCallbacks(rows: CallbackRow[]) { for (const r of rows) this.callbacks.set(r.id, { ...r, used: false }); }
  async takeCallback(id: string, userId: string) {
    const c = this.callbacks.get(id);
    if (!c || c.used || c.user_id !== userId) return null;
    c.used = true;
    return c;
  }
  async requeue(max: number) {
    for (const u of this.updates.values()) if (u.status === 'failed' && u.attempts < max) u.status = 'received';
    return [...new Set([...this.updates.values()].filter((u) => u.status === 'received' && u.user_id).map((u) => u.chat_id))].map((chatId) => ({ chatId, userId: USER }));
  }
}

type Sent = { method: string; chatId?: number; text?: string; opts?: Record<string, unknown>; markup?: InlineKeyboard };

function recordingBot(sent: Sent[], opts: { rejectHtml?: boolean } = {}): BotApi {
  let id = 500;
  return {
    async sendMessage(chatId, text, o) {
      if (opts.rejectHtml && o?.parse_mode) throw new TelegramError('sendMessage', 400, "Bad Request: can't parse entities");
      sent.push({ method: 'sendMessage', chatId, text, opts: o as Record<string, unknown> });
      return { message_id: ++id, date: 0, chat: { id: chatId, type: 'private' } };
    },
    async editMessageText(chatId, _m, text) { sent.push({ method: 'editMessageText', chatId, text }); },
    async editMessageReplyMarkup(chatId, _m, markup) { sent.push({ method: 'editMessageReplyMarkup', chatId, markup }); },
    async deleteMessage() { /* not used */ },
    async sendChatAction(chatId, action) { sent.push({ method: 'sendChatAction', chatId, text: action }); },
    async sendMessageDraft(chatId, _d, text) { sent.push({ method: 'sendMessageDraft', chatId, text }); },
    async answerCallbackQuery(cbId) { sent.push({ method: 'answerCallbackQuery', text: cbId }); },
    async setMessageReaction() { /* not used */ },
    async getFile(fileId) { return { file_id: fileId, file_unique_id: fileId, file_path: `files/${fileId}`, file_size: 1000 }; },
    async downloadFile() { return new Uint8Array([1, 2, 3]); },
    async call<T>() { return {} as T; },
  };
}

const agentResult = (text: string, ui: Partial<AgentResult['ui']> = {}): AgentResult => ({
  runId: 'run-1', text, decision: 'answered', model: 'test', toolCalls: [], latencyMs: 1, messageId: 'msg-1', userMessageId: 'umsg-1',
  ui: { proposedMemories: [], pendingActions: [], sentMessages: [], loggedMeals: [], actions: [], ...ui },
});

let n = 1;
const msg = (from: number, extra: Record<string, unknown>): TgUpdate => ({
  update_id: n++, message: { message_id: n, date: 0, chat: { id: from, type: 'private' }, from: { id: from }, ...extra },
}) as TgUpdate;
const post = (u: TgUpdate, secret = SECRET) => new Request('https://x/api/telegram/webhook', { method: 'POST', headers: { 'x-telegram-bot-api-secret-token': secret, 'content-type': 'application/json' }, body: JSON.stringify(u) });

function harness(opts: { agent?: (o: AgentOptions) => Promise<AgentResult>; rejectHtml?: boolean } = {}) {
  const store = new MemoryStore();
  const sent: Sent[] = [];
  const bot = recordingBot(sent, { rejectHtml: opts.rejectHtml });
  const agentCalls: AgentOptions[] = [];
  const tasks: (() => Promise<void>)[] = [];
  const turn: TurnDeps = {
    bot, store, appUrl: 'https://app.test',
    userClient: async () => ({}) as SupabaseClient,
    runAgent: async (o) => { agentCalls.push(o); return opts.agent ? opts.agent(o) : agentResult(`Ответ на: ${o.userText}`); },
    savePhoto: async (_sb, _u, _b, fileId) => ({ mediaId: `m-${fileId}`, path: `p/${fileId}`, data: new Uint8Array([1]), mime: 'image/jpeg' }),
    transcribeVoice: async () => ({ text: 'съел 200 г гречки', mediaId: 'a-1' }),
  };
  const worker: WorkerDeps = { store, bot, turn: (b, o) => runTurn(b, o, turn), albumWindowMs: 0, sleep: async () => undefined };
  const webhook: WebhookDeps = {
    store, secret: SECRET, schedule: (t) => { tasks.push(t); },
    process: (chatId, owner) => processChat(chatId, owner, worker),
    ackCallback: async (id) => { await bot.answerCallbackQuery(id); },
    stranger: (c) => handleStranger(c, { store, bot, pairingCode: CODE }),
  };
  const drain = async () => { while (tasks.length) await tasks.shift()!(); };
  const pairOwner = () => { store.profile = { userId: USER, telegramUserId: OWNER_TG, chatId: OWNER_TG }; };
  return { store, sent, bot, agentCalls, webhook, worker, drain, pairOwner };
}

beforeEach(() => { n = 1000 + Math.floor(Math.random() * 1000) * 100; });

describe('webhook security and idempotency', () => {
  test('a wrong or missing secret is 401 and nothing is stored', async () => {
    const h = harness();
    expect((await handleWebhook(post(msg(OWNER_TG, { text: 'hi' }), 'wrong'), h.webhook)).status).toBe(401);
    expect(h.store.updates.size).toBe(0);
    expect(secretMatches(null, SECRET)).toBe(false);
    expect(secretMatches(SECRET, SECRET)).toBe(true);
  });
  test('a duplicate update_id is answered 200 and handled once', async () => {
    const h = harness();
    h.pairOwner();
    const u = msg(OWNER_TG, { text: 'грудка 250, рис 150' });
    expect((await handleWebhook(post(u), h.webhook)).status).toBe(200);
    expect((await handleWebhook(post(u), h.webhook)).status).toBe(200);
    await h.drain();
    expect(h.agentCalls).toHaveLength(1);
    expect(h.agentCalls[0]).toMatchObject({ userText: 'грудка 250, рис 150', trigger: 'chat', channel: 'telegram', userId: USER });
    expect(h.store.updates.get(u.update_id)?.status).toBe('done');
  });
});

describe('only the owner', () => {
  test('a stranger gets one refusal a minute, no model call, no content stored', async () => {
    const h = harness();
    h.pairOwner();
    await handleWebhook(post(msg(STRANGER_TG, { text: 'секретный текст' })), h.webhook);
    await handleWebhook(post(msg(STRANGER_TG, { text: 'ещё' })), h.webhook);
    await h.drain();
    expect(h.agentCalls).toHaveLength(0);
    const refusals = h.sent.filter((s) => s.method === 'sendMessage' && s.text === REFUSAL);
    expect(refusals).toHaveLength(1);
    for (const u of h.store.updates.values()) {
      expect(u.payload).toEqual({});
      expect(u.kind).toBe('foreign');
      expect(u.status).toBe('ignored');
    }
  });
  test('pairing with the code links the owner once; the code cannot be reused', async () => {
    const h = harness();
    await handleWebhook(post(msg(OWNER_TG, { text: `/start ${CODE}` })), h.webhook);
    await h.drain();
    expect(h.store.profile.telegramUserId).toBe(OWNER_TG);
    expect(h.store.pairings.has(codeHash(CODE))).toBe(true);
    expect(h.sent.some((s) => s.text?.startsWith('Готово: бот привязан'))).toBe(true);
    await handleWebhook(post(msg(STRANGER_TG, { text: `/start ${CODE}` })), h.webhook);
    await h.drain();
    expect(h.store.profile.telegramUserId).toBe(OWNER_TG);
    expect(h.sent.filter((s) => s.text === REFUSAL)).toHaveLength(1);
  });
  test('a wrong code does not pair', async () => {
    const h = harness();
    await handleWebhook(post(msg(STRANGER_TG, { text: '/start nope' })), h.webhook);
    await h.drain();
    expect(h.store.profile.telegramUserId).toBeNull();
  });
});

describe('turns', () => {
  test('reply is HTML with meal card and edit/delete buttons; drafts stream on events', async () => {
    const h = harness({
      agent: async (o) => {
        o.onEvent?.({ t: 'tool', name: 'log_meal', label: 'Записываю приём' });
        await new Promise((r) => setTimeout(r, 1100));
        return agentResult('Записал **обед**, остаток 600 ккал.', { loggedMeals: [{ id: 'meal-9', title: 'Грудка, рис', kcal: 640, protein_g: 52, fat_g: 18, carbs_g: 61 }] });
      },
    });
    h.pairOwner();
    await handleWebhook(post(msg(OWNER_TG, { text: 'грудка 250, рис 150' })), h.webhook);
    await h.drain();
    const reply = h.sent.find((s) => s.method === 'sendMessage' && s.text?.includes('обед'))!;
    expect(reply.text).toContain('<b>обед</b>');
    expect(reply.text).toContain('🍽 Грудка, рис — 640 ккал · Б 52 · Ж 18 · У 61');
    const kb = (reply.opts?.reply_markup as InlineKeyboard).inline_keyboard;
    expect(kb[0][0]).toMatchObject({ text: '✏️ Исправить', web_app: { url: 'https://app.test/?meal=meal-9' } });
    expect(kb[0][1].callback_data).toMatch(/^c:/);
    expect(h.sent.some((s) => s.method === 'sendMessageDraft' && s.text === 'Записываю приём…')).toBe(true);
    expect(h.sent.some((s) => s.method === 'sendChatAction')).toBe(true);
  }, 10_000);
  test('a choice button: spinner answered at once, keyboard marked, agent gets the option, a second press does nothing', async () => {
    const h = harness({ agent: async (o) => agentResult(o.userText === 'С сахаром' ? 'Записал с сахаром.' : 'Какой?', o.userText === 'С сахаром' ? {} : { choices: { question: 'Какой?', options: ['С сахаром', 'Без сахара'] } }) });
    h.pairOwner();
    await handleWebhook(post(msg(OWNER_TG, { text: 'выпил Fuse Tea' })), h.webhook);
    await h.drain();
    const asked = h.sent.find((s) => s.method === 'sendMessage' && s.text === 'Какой?')!;
    const markup = asked.opts?.reply_markup as InlineKeyboard;
    const pick = markup.inline_keyboard.flat().find((b) => b.text === 'С сахаром')!;
    const press = (id: number): TgUpdate => ({ update_id: id, callback_query: { id: `cb${id}`, from: { id: OWNER_TG }, data: pick.callback_data, message: { message_id: 501, date: 0, chat: { id: OWNER_TG, type: 'private' }, reply_markup: markup } } });
    await handleWebhook(post(press(n++)), h.webhook);
    await h.drain();
    expect(h.sent.some((s) => s.method === 'answerCallbackQuery')).toBe(true);
    const edited = h.sent.find((s) => s.method === 'editMessageReplyMarkup')!;
    expect(edited.markup?.inline_keyboard).toEqual([[{ text: '✓ С сахаром', callback_data: 'n' }]]);
    expect(h.agentCalls.map((a) => a.userText)).toEqual(['выпил Fuse Tea', 'С сахаром']);
    await handleWebhook(post(press(n++)), h.webhook);
    await h.drain();
    expect(h.agentCalls).toHaveLength(2);
  });
  test('an album of three photos is one agent turn with three images', async () => {
    const h = harness();
    h.pairOwner();
    for (const f of ['a', 'b', 'c']) {
      await handleWebhook(post(msg(OWNER_TG, { media_group_id: 'g1', photo: [{ file_id: `${f}-small`, file_unique_id: f, width: 90, height: 90 }, { file_id: f, file_unique_id: `${f}2`, width: 1280, height: 960 }], ...(f === 'a' ? { caption: 'обед' } : {}) })), h.webhook);
    }
    await h.drain();
    expect(h.agentCalls).toHaveLength(1);
    expect(h.agentCalls[0].images?.map((i) => i.mediaId)).toEqual(['m-a', 'm-b', 'm-c']);
    expect(h.agentCalls[0].userText).toBe('обед');
  });
  test('a voice note: the transcript goes to the agent and opens the reply', async () => {
    const h = harness();
    h.pairOwner();
    await handleWebhook(post(msg(OWNER_TG, { voice: { file_id: 'v1', file_unique_id: 'v1', duration: 3, mime_type: 'audio/ogg' } })), h.webhook);
    await h.drain();
    expect(h.agentCalls[0].userText).toBe('съел 200 г гречки');
    expect(h.sent.find((s) => s.method === 'sendMessage')?.text?.startsWith('🎙 «съел 200 г гречки»')).toBe(true);
  });
  test('Telegram rejects the markup → the same text goes plain', async () => {
    const h = harness({ rejectHtml: true });
    h.pairOwner();
    await handleWebhook(post(msg(OWNER_TG, { text: 'привет' })), h.webhook);
    await h.drain();
    const reply = h.sent.find((s) => s.method === 'sendMessage')!;
    expect(reply.opts?.parse_mode).toBeUndefined();
    expect(reply.text).toBe('Ответ на: привет');
  });
});

describe('failures and retries', () => {
  test('a failed turn notifies once, is retried by the safety net and then succeeds', async () => {
    let fail = true;
    const h = harness({ agent: async (o) => { if (fail) throw new Error('boom'); return agentResult(`ок: ${o.userText}`); } });
    h.pairOwner();
    const u = msg(OWNER_TG, { text: 'тест' });
    await handleWebhook(post(u), h.webhook);
    await h.drain();
    expect(h.store.updates.get(u.update_id)?.status).toBe('failed');
    expect(h.sent.filter((s) => s.text === RETRY_NOTICE)).toHaveLength(1);
    fail = false;
    for (const ch of await h.store.requeue(3)) await processChat(ch.chatId, { userId: ch.userId, telegramUserId: 0, chatId: ch.chatId }, h.worker);
    expect(h.store.updates.get(u.update_id)?.status).toBe('done');
    expect(h.sent.some((s) => s.text === 'ок: тест')).toBe(true);
  });
  test('after the last attempt the owner is told it was not handled', async () => {
    const h = harness({ agent: async () => { throw new Error('boom'); } });
    h.pairOwner();
    const u = msg(OWNER_TG, { text: 'тест' });
    await handleWebhook(post(u), h.webhook);
    await h.drain();
    for (let i = 0; i < 2; i++) for (const ch of await h.store.requeue(3)) await processChat(ch.chatId, { userId: ch.userId, telegramUserId: 0, chatId: ch.chatId }, h.worker);
    expect(h.store.updates.get(u.update_id)?.attempts).toBe(3);
    expect(h.sent.some((s) => s.text === GAVE_UP_NOTICE)).toBe(true);
  });
  test('one worker per chat: a second worker returns while the first holds the lease', async () => {
    const h = harness();
    h.pairOwner();
    expect(await h.store.acquireChat(OWNER_TG, 'other', 60)).toBe(true);
    await handleWebhook(post(msg(OWNER_TG, { text: 'ждёт' })), h.webhook);
    await h.drain();
    expect(h.agentCalls).toHaveLength(0);
    await h.store.releaseChat(OWNER_TG, 'other');
    for (const ch of await h.store.requeue(3)) await processChat(ch.chatId, { userId: ch.userId, telegramUserId: 0, chatId: ch.chatId }, h.worker);
    expect(h.agentCalls).toHaveLength(1);
  });
});

describe('helpers', () => {
  test('classify: commands, photos as documents, groups ignored', () => {
    expect(classify(msg(1, { text: '/mute@Bot 3' })).command).toEqual({ name: 'mute', arg: '3' });
    expect(classify(msg(1, { document: { file_id: 'd', file_unique_id: 'd', mime_type: 'image/png' } })).kind).toBe('photo');
    expect(classify({ update_id: 1, message: { message_id: 1, date: 0, chat: { id: -5, type: 'group' }, from: { id: 1 }, text: 'hi' } }).kind).toBe('other');
  });
  test('bestPhoto picks the largest size', () => {
    expect(bestPhoto({ message_id: 1, date: 0, chat: { id: 1, type: 'private' }, photo: [{ file_id: 's', file_unique_id: 's', width: 90, height: 90 }, { file_id: 'l', file_unique_id: 'l', width: 1280, height: 720 }] })?.fileId).toBe('l');
  });
  test('markKeyboard keeps other rows and marks the pressed one', () => {
    const kb: InlineKeyboard = { inline_keyboard: [[{ text: 'A', callback_data: 'q:1' }, { text: 'B', callback_data: 'q:2' }], [{ text: '🗑', callback_data: 'c:3' }]] };
    expect(markKeyboard(kb, (b) => Boolean(b.callback_data?.startsWith('q:')), '✓ A')).toEqual({ inline_keyboard: [[{ text: '✓ A', callback_data: 'n' }], [{ text: '🗑', callback_data: 'c:3' }]] });
  });
});
