import 'server-only';
import type { InlineKeyboard, SendOptions, TgFile, TgMessage } from './types';

// Bot API over HTTPS. One retry on 429 (Telegram says how long to wait); the token never
// appears in errors or logs.

const API = 'https://api.telegram.org';
const TIMEOUT_MS = 20_000;
const MAX_RETRY_WAIT_S = 5;

export class TelegramError extends Error {
  constructor(public method: string, public code: number, public description: string, public retryAfter?: number) {
    super(`telegram ${method}: ${code} ${description}`.slice(0, 300));
    this.name = 'TelegramError';
  }
}

/** Everything the bot sends; an interface so tests can record calls instead of hitting Telegram. */
export type BotApi = {
  sendMessage(chatId: number, text: string, opts?: SendOptions): Promise<TgMessage>;
  editMessageText(chatId: number, messageId: number, text: string, opts?: SendOptions): Promise<void>;
  editMessageReplyMarkup(chatId: number, messageId: number, markup?: InlineKeyboard): Promise<void>;
  deleteMessage(chatId: number, messageId: number): Promise<void>;
  sendChatAction(chatId: number, action: 'typing' | 'upload_photo' | 'record_voice'): Promise<void>;
  sendMessageDraft(chatId: number, draftId: number, text: string, opts?: { parse_mode?: 'HTML' }): Promise<void>;
  answerCallbackQuery(id: string, text?: string): Promise<void>;
  setMessageReaction(chatId: number, messageId: number, emoji: string): Promise<void>;
  getFile(fileId: string): Promise<TgFile>;
  downloadFile(filePath: string): Promise<Uint8Array>;
  call<T>(method: string, params: Record<string, unknown>): Promise<T>;
};

type Envelope<T> = { ok: boolean; result?: T; error_code?: number; description?: string; parameters?: { retry_after?: number } };

export function httpBot(token: string): BotApi {
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN is not configured');

  async function call<T>(method: string, params: Record<string, unknown>, retried = false): Promise<T> {
    const res = await fetch(`${API}/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const body = (await res.json().catch(() => ({ ok: false, description: `http ${res.status}` }))) as Envelope<T>;
    if (body.ok) return body.result as T;
    const retryAfter = body.parameters?.retry_after;
    if (res.status === 429 && !retried && retryAfter != null && retryAfter <= MAX_RETRY_WAIT_S) {
      await new Promise((r) => setTimeout(r, retryAfter * 1000));
      return call<T>(method, params, true);
    }
    throw new TelegramError(method, body.error_code ?? res.status, body.description ?? 'error', retryAfter);
  }

  return {
    call,
    sendMessage: (chatId, text, opts) => call<TgMessage>('sendMessage', { chat_id: chatId, text, ...opts }),
    editMessageText: async (chatId, messageId, text, opts) => {
      try {
        await call('editMessageText', { chat_id: chatId, message_id: messageId, text, ...opts });
      } catch (e) {
        // Editing to the same text is not an error for us.
        if (!(e instanceof TelegramError && /message is not modified/i.test(e.description))) throw e;
      }
    },
    editMessageReplyMarkup: async (chatId, messageId, markup) => {
      try {
        await call('editMessageReplyMarkup', { chat_id: chatId, message_id: messageId, reply_markup: markup ?? { inline_keyboard: [] } });
      } catch (e) {
        if (!(e instanceof TelegramError && /message is not modified/i.test(e.description))) throw e;
      }
    },
    deleteMessage: async (chatId, messageId) => { await call('deleteMessage', { chat_id: chatId, message_id: messageId }); },
    sendChatAction: async (chatId, action) => { await call('sendChatAction', { chat_id: chatId, action }); },
    sendMessageDraft: async (chatId, draftId, text, opts) => { await call('sendMessageDraft', { chat_id: chatId, draft_id: draftId, text, ...opts }); },
    answerCallbackQuery: async (id, text) => { await call('answerCallbackQuery', { callback_query_id: id, ...(text ? { text } : {}) }); },
    setMessageReaction: async (chatId, messageId, emoji) => {
      await call('setMessageReaction', { chat_id: chatId, message_id: messageId, reaction: [{ type: 'emoji', emoji }] });
    },
    getFile: (fileId) => call<TgFile>('getFile', { file_id: fileId }),
    downloadFile: async (filePath) => {
      const res = await fetch(`${API}/file/bot${token}/${filePath}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!res.ok) throw new TelegramError('downloadFile', res.status, 'download failed');
      return new Uint8Array(await res.arrayBuffer());
    },
  };
}
