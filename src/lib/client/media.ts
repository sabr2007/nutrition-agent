'use client';

import { supabaseBrowser } from '@/lib/supabase/browser';

const MAX_SIDE = 1280;

/** Downscale a camera photo to ≤1280px JPEG (~150–400 KB) before upload. */
export async function prepareImage(file: File): Promise<{ blob: Blob; width: number; height: number }> {
  const bitmap = await createImageBitmap(file).catch(() => null);
  if (!bitmap) return { blob: file, width: 0, height: 0 };
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const w = Math.round(bitmap.width * scale);
  const h = Math.round(bitmap.height * scale);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, w, h);
  const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('encode failed'))), 'image/jpeg', 0.82));
  return { blob, width: w, height: h };
}

async function sha256(blob: Blob): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Uploads a raw input to the private bucket and registers it in `media`. */
export async function uploadMedia(userId: string, kind: 'photo' | 'audio' | 'body_photo', blob: Blob, ext: string, meta: { width?: number; height?: number; duration_ms?: number } = {}): Promise<string> {
  const sb = supabaseBrowser();
  const day = new Date().toISOString().slice(0, 10);
  const path = `${userId}/${kind}/${day}/${crypto.randomUUID()}.${ext}`;
  const { error } = await sb.storage.from('media').upload(path, blob, { contentType: blob.type || (kind === 'audio' ? 'audio/mp4' : 'image/jpeg'), upsert: false });
  if (error) throw new Error(`Не удалось загрузить файл: ${error.message}`);
  const { data, error: e2 } = await sb.from('media').insert({
    user_id: userId, kind, bucket: 'media', path, mime: blob.type || null, bytes: blob.size,
    width: meta.width ?? null, height: meta.height ?? null, duration_ms: meta.duration_ms ?? null, sha256: await sha256(blob),
  }).select('id').single();
  if (e2) throw new Error(e2.message);
  return data.id as string;
}

/** Best audio container for MediaRecorder: iOS Safari records audio/mp4 (AAC). */
export function pickAudioMime(): { mime: string; ext: string } {
  const options = [
    { mime: 'audio/mp4', ext: 'm4a' },
    { mime: 'audio/webm;codecs=opus', ext: 'webm' },
    { mime: 'audio/webm', ext: 'webm' },
  ];
  for (const o of options) if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(o.mime)) return o;
  return { mime: '', ext: 'm4a' };
}
