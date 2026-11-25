import type { SupabaseClient } from '@supabase/supabase-js';
import type { AgentImage, AgentOptions, AgentResult } from '@/lib/agent/run';
import type { BotApi } from './bot';
import { handleCallback } from './callbacks';
import { handleCommand } from './commands';
import { buildOfflineReply, AGENT_DOWN, type OfflineOffer } from './offline';
import { sendAgentReply, sendBuilt } from './reply';
import type { Owner, StoredUpdate, TgStore } from './store';
import { createStreamer } from './stream';
import { bestPhoto, classify } from './update';
import type { TgMessage } from './types';
import type { VoiceNote } from './media';

// One turn of the conversation from a queued update (or a whole album): commands, button
// presses, voice → transcript, photos → the agent's eyes, text → the agent. Same agent, same
// thread and same tables as the app's chat (runAgent with trigger 'chat').

export type TurnDeps = {
  bot: BotApi;
  store: TgStore;
  appUrl: string;
  /** A user-scoped Supabase client for the owner (RLS applies). */
  userClient: (userId: string) => Promise<SupabaseClient>;
  runAgent: (opts: AgentOptions) => Promise<AgentResult>;
  savePhoto: (sb: SupabaseClient, userId: string, bot: BotApi, fileId: string, caption: string) => Promise<AgentImage>;
  transcribeVoice: (sb: SupabaseClient, userId: string, bot: BotApi, v: VoiceNote) => Promise<{ text: string; mediaId: string }>;
  /** The free paths (quick parser, templates) for when the agent is out. */
  offlineOffer: (sb: SupabaseClient, userId: string, text: string) => Promise<OfflineOffer>;
  now?: () => Date;
};

const MISHEARD = 'Не расслышал — повтори, пожалуйста, или напиши текстом.';

function voiceOf(m: TgMessage): VoiceNote | null {
  if (m.voice) return { fileId: m.voice.file_id, mime: (m.voice.mime_type ?? 'audio/ogg').split(';')[0], durationS: m.voice.duration, ext: 'ogg' };
  if (m.audio) return { fileId: m.audio.file_id, mime: (m.audio.mime_type ?? 'audio/mpeg').split(';')[0], durationS: m.audio.duration, ext: 'mp3' };
  if (m.video_note) return { fileId: m.video_note.file_id, mime: 'video/mp4', durationS: m.video_note.duration, ext: 'mp4' };
  return null;
}

export async function runTurn(batch: StoredUpdate[], owner: Owner, deps: TurnDeps): Promise<{ runId?: string | null }> {
  const first = batch[0];
  const c = classify(first.payload);
  const chatId = c.chatId ?? owner.chatId;
  if (chatId == null) return {};
  let client: Promise<SupabaseClient> | null = null;
  const userClient = () => (client ??= deps.userClient(owner.userId));

  const agentTurn = async (text: string, extra: { images?: AgentImage[]; prefix?: string; skillKey?: string } = {}) => {
    const state = await deps.store.chatState(chatId);
    if (state.deepNext) await deps.store.setChatState(chatId, { deepNext: false });
    const streamer = createStreamer(deps.bot, chatId);
    try {
      const r = await deps.runAgent({
        sb: await userClient(), userId: owner.userId, trigger: 'chat', userText: text, images: extra.images,
        deep: state.deepNext, skillKey: extra.skillKey ?? null, channel: 'telegram', onEvent: (e) => streamer.event(e),
      });
      await streamer.stop();
      if (r.decision === 'error' && r.errorClass && AGENT_DOWN.has(r.errorClass)) {
        const offer = await deps.offlineOffer(await userClient(), owner.userId, extra.images?.length ? '' : text);
        await sendBuilt({ bot: deps.bot, store: deps.store, chatId }, buildOfflineReply(r.errorClass, offer, { userId: owner.userId, chatId }));
        return { runId: r.runId };
      }
      await sendAgentReply({ bot: deps.bot, store: deps.store, userId: owner.userId, chatId, appUrl: deps.appUrl }, r, { prefix: extra.prefix });
      return { runId: r.runId };
    } finally {
      await streamer.stop();
    }
  };

  switch (c.kind) {
    case 'command':
      return handleCommand(c, { bot: deps.bot, store: deps.store, owner, chatId, appUrl: deps.appUrl, userClient, agentTurn, now: deps.now });
    case 'callback':
      return handleCallback(first, c, { bot: deps.bot, store: deps.store, owner, chatId, userClient, agentTurn: (t) => agentTurn(t) });
    case 'voice': {
      const v = first.payload.message ? voiceOf(first.payload.message) : null;
      if (!v) return {};
      await deps.bot.sendChatAction(chatId, 'typing').catch(() => undefined);
      const { text } = await deps.transcribeVoice(await userClient(), owner.userId, deps.bot, v);
      if (!text) {
        await deps.bot.sendMessage(chatId, MISHEARD);
        return {};
      }
      const caption = c.text ? `${c.text}\n` : '';
      return agentTurn(`${caption}${text}`, { prefix: `🎙 «${text}»` });
    }
    case 'photo': {
      await deps.bot.sendChatAction(chatId, 'upload_photo').catch(() => undefined);
      const sb = await userClient();
      const captions = batch.map((u) => classify(u.payload).text).filter(Boolean);
      const caption = [...new Set(captions)].join('\n');
      const images: AgentImage[] = [];
      for (const u of batch) {
        const photo = u.payload.message ? bestPhoto(u.payload.message) : null;
        if (photo) images.push(await deps.savePhoto(sb, owner.userId, deps.bot, photo.fileId, caption));
      }
      if (!images.length) return {};
      return agentTurn(caption, { images });
    }
    case 'text':
      return agentTurn(c.text);
    default:
      return {};
  }
}
