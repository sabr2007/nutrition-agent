import type { TgMessage, TgUpdate } from './types';

export type UpdateKind = 'text' | 'command' | 'photo' | 'voice' | 'callback' | 'other';

export type Classified = {
  updateId: number;
  chatId: number | null;
  fromId: number | null;
  kind: UpdateKind;
  /** Message text, photo caption, or the callback's data. */
  text: string;
  command?: { name: string; arg: string };
  mediaGroupId?: string;
  messageId?: number;
  callback?: { id: string; data: string; messageId?: number };
};

const IMAGE_MIME = /^image\/(jpeg|png|webp|heic|heif)$/i;

function messageKind(m: TgMessage): UpdateKind {
  if (m.photo?.length || (m.document && IMAGE_MIME.test(m.document.mime_type ?? ''))) return 'photo';
  if (m.voice || m.audio || m.video_note) return 'voice';
  if (m.text?.startsWith('/')) return 'command';
  if (m.text?.trim()) return 'text';
  return 'other';
}

/** What an update is, who sent it and where — without trusting anything else in it. */
export function classify(u: TgUpdate): Classified {
  if (u.callback_query) {
    const c = u.callback_query;
    const chat = c.message?.chat;
    return {
      updateId: u.update_id, chatId: chat?.type === 'private' ? chat.id : null, fromId: c.from?.id ?? null,
      kind: 'callback', text: c.data ?? '', messageId: c.message?.message_id,
      callback: { id: c.id, data: c.data ?? '', messageId: c.message?.message_id },
    };
  }
  const m = u.message;
  if (!m || m.chat.type !== 'private') {
    // Edits, channel posts and group messages are not part of the conversation.
    return { updateId: u.update_id, chatId: m?.chat.type === 'private' ? m.chat.id : null, fromId: m?.from?.id ?? null, kind: 'other', text: '' };
  }
  const kind = messageKind(m);
  const base: Classified = {
    updateId: u.update_id, chatId: m.chat.id, fromId: m.from?.id ?? null, kind, text: (m.text ?? m.caption ?? '').trim(),
    messageId: m.message_id, ...(m.media_group_id ? { mediaGroupId: m.media_group_id } : {}),
  };
  if (kind === 'command') {
    const [head, ...rest] = (m.text ?? '').trim().split(/\s+/);
    base.command = { name: head.slice(1).split('@')[0].toLowerCase(), arg: rest.join(' ').trim() };
  }
  return base;
}

/** The largest photo size that fits the download limit (Bot API: getFile ≤ 20 MB). */
export function bestPhoto(m: TgMessage): { fileId: string; size: number } | null {
  if (m.photo?.length) {
    const p = [...m.photo].sort((a, b) => b.width * b.height - a.width * a.height)[0];
    return { fileId: p.file_id, size: p.file_size ?? 0 };
  }
  if (m.document && IMAGE_MIME.test(m.document.mime_type ?? '')) return { fileId: m.document.file_id, size: m.document.file_size ?? 0 };
  return null;
}
