import 'server-only';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { AgentImage } from '@/lib/agent/run';
import { transcribeAudio } from '@/lib/llm/transcribe';
import type { BotApi } from './bot';

// Raw inputs from Telegram land where the app's own inputs land: the private `media` bucket
// (<user_id>/<kind>/<date>/<uuid>) plus a `media` row with sha256, size and dimensions.

/** getFile limit of the Bot API. */
const MAX_DOWNLOAD = 20 * 1024 * 1024;
const PHOTO_MAX_SIDE = 1280;
/** Labels and scale displays need small print: keep more pixels when the caption hints at it. */
const DETAIL_MAX_SIDE = 2048;
const DETAIL_HINT = /этикетк|состав|пищев|кбжу|бжу|на 100|штрихкод|весы|весах|взвес|грамм на|ккал на/i;
const JPEG_QUALITY = 82;

const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

async function download(bot: BotApi, fileId: string): Promise<Uint8Array> {
  const f = await bot.getFile(fileId);
  if (!f.file_path) throw new Error('telegram file has no path');
  if ((f.file_size ?? 0) > MAX_DOWNLOAD) throw new Error('file is over 20 MB');
  return bot.downloadFile(f.file_path);
}

async function store(sb: SupabaseClient, userId: string, kind: 'photo' | 'audio', bytes: Uint8Array, mime: string, ext: string, meta: { width?: number; height?: number; duration_ms?: number }) {
  const day = new Date().toISOString().slice(0, 10);
  const path = `${userId}/${kind}/${day}/${crypto.randomUUID()}.${ext}`;
  const { error } = await sb.storage.from('media').upload(path, bytes, { contentType: mime, upsert: false });
  if (error) throw new Error(`media upload: ${error.message.slice(0, 120)}`);
  const { data, error: e2 } = await sb.from('media').insert({
    user_id: userId, kind, bucket: 'media', path, mime, bytes: bytes.length, sha256: sha256(bytes),
    width: meta.width ?? null, height: meta.height ?? null, duration_ms: meta.duration_ms ?? null,
  }).select('id').single();
  if (e2 || !data) throw new Error(`media row: ${e2?.code ?? 'none'}`);
  return { mediaId: data.id as string, path };
}

/** Downloads a Telegram photo, downsizes it (EXIF-rotated JPEG) and stores it as the agent's input. */
export async function savePhoto(sb: SupabaseClient, userId: string, bot: BotApi, fileId: string, caption: string): Promise<AgentImage> {
  const raw = await download(bot, fileId);
  const maxSide = DETAIL_HINT.test(caption) ? DETAIL_MAX_SIDE : PHOTO_MAX_SIDE;
  const { data, info } = await sharp(raw).rotate().resize({ width: maxSide, height: maxSide, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: JPEG_QUALITY, mozjpeg: true }).toBuffer({ resolveWithObject: true });
  const bytes = new Uint8Array(data);
  const { mediaId, path } = await store(sb, userId, 'photo', bytes, 'image/jpeg', 'jpg', { width: info.width, height: info.height });
  return { mediaId, path, data: bytes, mime: 'image/jpeg' };
}

export type VoiceNote = { fileId: string; mime: string; durationS: number; ext: string };

/** Stores a voice note / audio / video note and returns what Whisper heard ('' for silence). */
export async function transcribeVoice(sb: SupabaseClient, userId: string, bot: BotApi, v: VoiceNote): Promise<{ text: string; mediaId: string }> {
  const bytes = await download(bot, v.fileId);
  const { mediaId } = await store(sb, userId, 'audio', bytes, v.mime, v.ext, { duration_ms: Math.round(v.durationS * 1000) });
  const tr = await transcribeAudio(bytes, { userId, purpose: 'transcribe_telegram' });
  return { text: tr.text, mediaId };
}
