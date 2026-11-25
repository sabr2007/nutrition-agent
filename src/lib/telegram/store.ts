import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { TgUpdate } from './types';

// Persistence of the bot: the update queue, chat leases, pairing and button payloads.
// An interface, so the webhook and worker can be tested against an in-memory fake.

export type Owner = { userId: string; telegramUserId: number; chatId: number | null };

export type StoredUpdate = {
  update_id: number; chat_id: number; user_id: string | null; kind: string; media_group_id: string | null;
  payload: TgUpdate; status: string; attempts: number; received_at: string;
};

export type ChatState = { deepNext: boolean; mutedUntil: string | null; lastRefusalAt: string | null };

export type CallbackRow = { id: string; user_id: string; chat_id: number; message_id: number | null; kind: string; payload: Record<string, unknown> };

export type NewUpdate = {
  update_id: number; chat_id: number | null; user_id: string | null; kind: string; media_group_id?: string | null;
  payload: TgUpdate | Record<string, never>; status: 'received' | 'ignored';
};

export type TgStore = {
  findOwnerByTelegram(telegramUserId: number): Promise<Owner | null>;
  /** False when the update_id is already stored (Telegram retried it). */
  insertUpdate(row: NewUpdate): Promise<boolean>;
  acquireChat(chatId: number, holder: string, seconds: number): Promise<boolean>;
  releaseChat(chatId: number, holder: string): Promise<void>;
  claimNext(chatId: number): Promise<StoredUpdate | null>;
  claimGroup(chatId: number, group: string): Promise<StoredUpdate[]>;
  latestGroupArrival(chatId: number, group: string): Promise<string | null>;
  hasWaiting(chatId: number): Promise<boolean>;
  finishUpdate(updateId: number, r: { status: 'done' | 'failed'; error?: string; runId?: string | null }): Promise<void>;
  chatState(chatId: number): Promise<ChatState>;
  setChatState(chatId: number, patch: Partial<ChatState>): Promise<void>;
  pairingUsed(codeSha256: string): Promise<boolean>;
  ownerProfile(): Promise<{ userId: string; telegramUserId: number | null } | null>;
  linkTelegram(userId: string, telegramUserId: number, chatId: number, codeSha256: string): Promise<void>;
  saveCallbacks(rows: CallbackRow[]): Promise<void>;
  /** Marks the button used and returns it; null if unknown, expired, foreign or already used. */
  takeCallback(id: string, userId: string): Promise<CallbackRow | null>;
  /** Requeues stuck or failed updates and returns the chats that have waiting updates. */
  requeue(maxAttempts: number): Promise<{ chatId: number; userId: string }[]>;
};

const camel = (r: Record<string, unknown> | null): ChatState => ({
  deepNext: Boolean(r?.deep_next), mutedUntil: (r?.muted_until as string) ?? null, lastRefusalAt: (r?.last_refusal_at as string) ?? null,
});

export function supabaseTgStore(admin: SupabaseClient): TgStore {
  return {
    async findOwnerByTelegram(telegramUserId) {
      const { data } = await admin.from('profiles').select('user_id, telegram_user_id, telegram_chat_id').eq('telegram_user_id', telegramUserId).maybeSingle();
      return data ? { userId: data.user_id as string, telegramUserId: Number(data.telegram_user_id), chatId: data.telegram_chat_id != null ? Number(data.telegram_chat_id) : null } : null;
    },
    async insertUpdate(row) {
      const { error } = await admin.from('tg_updates').insert({ ...row, media_group_id: row.media_group_id ?? null });
      if (!error) return true;
      if (error.code === '23505') return false;
      throw new Error(`tg_updates insert: ${error.code}`);
    },
    async acquireChat(chatId, holder, seconds) {
      const { data, error } = await admin.rpc('tg_acquire_chat', { p_chat: chatId, p_owner: holder, p_seconds: seconds });
      if (error) throw new Error(`tg_acquire_chat: ${error.code}`);
      return Boolean(data);
    },
    async releaseChat(chatId, holder) {
      await admin.rpc('tg_release_chat', { p_chat: chatId, p_owner: holder });
    },
    async claimNext(chatId) {
      const { data, error } = await admin.rpc('tg_claim_next', { p_chat: chatId });
      if (error) throw new Error(`tg_claim_next: ${error.code}`);
      return ((data ?? []) as StoredUpdate[])[0] ?? null;
    },
    async claimGroup(chatId, group) {
      const { data, error } = await admin.rpc('tg_claim_group', { p_chat: chatId, p_group: group });
      if (error) throw new Error(`tg_claim_group: ${error.code}`);
      return (data ?? []) as StoredUpdate[];
    },
    async latestGroupArrival(chatId, group) {
      const { data } = await admin.from('tg_updates').select('received_at').eq('chat_id', chatId).eq('media_group_id', group)
        .order('received_at', { ascending: false }).limit(1);
      return (data?.[0]?.received_at as string) ?? null;
    },
    async hasWaiting(chatId) {
      const { count } = await admin.from('tg_updates').select('update_id', { count: 'exact', head: true }).eq('chat_id', chatId).eq('status', 'received');
      return (count ?? 0) > 0;
    },
    async finishUpdate(updateId, r) {
      await admin.from('tg_updates').update({ status: r.status, error: r.error ?? null, run_id: r.runId ?? null, finished_at: new Date().toISOString() }).eq('update_id', updateId);
    },
    async chatState(chatId) {
      const { data } = await admin.from('tg_chats').select('deep_next, muted_until, last_refusal_at').eq('chat_id', chatId).maybeSingle();
      return camel(data);
    },
    async setChatState(chatId, patch) {
      const row: Record<string, unknown> = { chat_id: chatId, updated_at: new Date().toISOString() };
      if (patch.deepNext !== undefined) row.deep_next = patch.deepNext;
      if (patch.mutedUntil !== undefined) row.muted_until = patch.mutedUntil;
      if (patch.lastRefusalAt !== undefined) row.last_refusal_at = patch.lastRefusalAt;
      await admin.from('tg_chats').upsert(row, { onConflict: 'chat_id' });
    },
    async pairingUsed(codeSha256) {
      const { count } = await admin.from('tg_pairings').select('code_sha256', { count: 'exact', head: true }).eq('code_sha256', codeSha256);
      return (count ?? 0) > 0;
    },
    async ownerProfile() {
      // Single-owner app: the first account is the owner.
      const { data } = await admin.from('profiles').select('user_id, telegram_user_id').order('created_at').limit(1);
      const p = data?.[0];
      return p ? { userId: p.user_id as string, telegramUserId: p.telegram_user_id != null ? Number(p.telegram_user_id) : null } : null;
    },
    async linkTelegram(userId, telegramUserId, chatId, codeSha256) {
      const { error: e1 } = await admin.from('tg_pairings').insert({ code_sha256: codeSha256, user_id: userId, telegram_user_id: telegramUserId });
      if (e1) throw new Error(`tg_pairings: ${e1.code}`);
      const { error: e2 } = await admin.from('profiles').update({ telegram_user_id: telegramUserId, telegram_chat_id: chatId, telegram_linked_at: new Date().toISOString() }).eq('user_id', userId);
      if (e2) throw new Error(`profiles link: ${e2.code}`);
      await admin.from('tg_chats').upsert({ chat_id: chatId, user_id: userId, updated_at: new Date().toISOString() }, { onConflict: 'chat_id' });
    },
    async saveCallbacks(rows) {
      if (!rows.length) return;
      const { error } = await admin.from('tg_callbacks').insert(rows);
      if (error) throw new Error(`tg_callbacks: ${error.code}`);
    },
    async takeCallback(id, userId) {
      const { data } = await admin.from('tg_callbacks').update({ used_at: new Date().toISOString() })
        .eq('id', id).eq('user_id', userId).is('used_at', null).gt('expires_at', new Date().toISOString())
        .select('id, user_id, chat_id, message_id, kind, payload').maybeSingle();
      return (data as CallbackRow | null) ?? null;
    },
    async requeue(maxAttempts) {
      const { data, error } = await admin.rpc('tg_requeue', { p_max_attempts: maxAttempts });
      if (error) throw new Error(`tg_requeue: ${error.code}`);
      return ((data ?? []) as { chat_id: number; user_id: string }[]).map((r) => ({ chatId: Number(r.chat_id), userId: r.user_id }));
    },
  };
}
