import type { ChatEvent } from '@/lib/chat/protocol';
import type { BotApi } from './bot';

// While the agent works: «typing…» every 4 s, and the reply streams as a native Telegram draft
// (sendMessageDraft, Bot API 9.3+) at most once a second — tool statuses («Записываю приём…»)
// until the first words arrive. The final message is sent separately and replaces the draft.
// If drafts are refused, only «typing…» stays.

const TYPING_EVERY_MS = 4000;
const DRAFT_EVERY_MS = 1000;
const DRAFT_MAX = 4000;

/** Plain text for a draft: partial Markdown would show stray markers. */
export function draftText(s: string): string {
  return s.replace(/\*\*|__|~~|`/g, '').replace(/^#{1,6}\s+/gm, '').replace(/^\s*[-*+]\s+/gm, '• ').trim();
}

export type Streamer = { event: (e: ChatEvent) => void; stop: () => Promise<void> };

export function createStreamer(bot: BotApi, chatId: number, opts: { draftEveryMs?: number; typingEveryMs?: number } = {}): Streamer {
  const draftId = 1 + Math.floor(Math.random() * 2_000_000_000);
  const every = opts.draftEveryMs ?? DRAFT_EVERY_MS;
  let text = '';
  let status = '';
  let lastSent = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: Promise<void> = Promise.resolve();
  let draftsOff = false;
  let stopped = false;

  const typing = () => { if (!stopped) bot.sendChatAction(chatId, 'typing').catch(() => undefined); };
  typing();
  const typingTimer = setInterval(typing, opts.typingEveryMs ?? TYPING_EVERY_MS);

  const flush = async () => {
    if (draftsOff || stopped) return;
    const body = draftText(text || (status ? `${status}…` : '')).slice(-DRAFT_MAX);
    if (!body) return;
    lastSent = Date.now();
    try {
      await bot.sendMessageDraft(chatId, draftId, body);
    } catch {
      draftsOff = true;
    }
  };
  const schedule = () => {
    if (timer || draftsOff || stopped) return;
    timer = setTimeout(() => { timer = null; pending = flush(); }, Math.max(0, every - (Date.now() - lastSent)));
  };

  return {
    event(e) {
      if (e.t === 'text') text += e.d;
      else if (e.t === 'tool') status = e.label;
      else return;
      schedule();
    },
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      clearInterval(typingTimer);
      await pending.catch(() => undefined);
    },
  };
}
