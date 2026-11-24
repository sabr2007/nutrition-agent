'use client';

import { useCallback, useState } from 'react';
import { prepareImage, uploadMedia } from '@/lib/client/media';

export const MAX_PHOTOS = 4;

export type Attachment = {
  key: string;
  /** Local object URL: shown at once, and reused by the sent message until the stored copy loads. */
  previewUrl: string;
  status: 'uploading' | 'ready' | 'error';
  mediaId: string | null;
};

/** Photos attached in the composer: shown immediately, uploaded to the private bucket in the background. */
export function useAttachments(userId: string | undefined) {
  const [items, setItems] = useState<Attachment[]>([]);

  const patch = useCallback((key: string, next: Partial<Attachment>) => {
    setItems((xs) => xs.map((a) => (a.key === key ? { ...a, ...next } : a)));
  }, []);

  const upload = useCallback(async (key: string, file: File) => {
    if (!userId) {
      patch(key, { status: 'error' });
      return;
    }
    try {
      const { blob, width, height } = await prepareImage(file);
      const mediaId = await uploadMedia(userId, 'photo', blob, 'jpg', { width, height });
      patch(key, { status: 'ready', mediaId });
    } catch {
      patch(key, { status: 'error' });
    }
  }, [patch, userId]);

  /** Adds up to the photo limit; returns how many were skipped. */
  const add = useCallback((files: FileList | File[]): number => {
    const list = Array.from(files).filter((f) => f.type.startsWith('image/') || /\.(heic|heif)$/i.test(f.name));
    const room = Math.max(0, MAX_PHOTOS - items.length);
    const added = list.slice(0, room).map((file) => ({
      file,
      attachment: { key: crypto.randomUUID(), previewUrl: URL.createObjectURL(file), status: 'uploading', mediaId: null } satisfies Attachment,
    }));
    setItems((xs) => [...xs, ...added.map((a) => a.attachment)]);
    for (const a of added) void upload(a.attachment.key, a.file);
    return Math.max(0, list.length - room);
  }, [items.length, upload]);

  const remove = useCallback((key: string) => {
    const gone = items.find((a) => a.key === key);
    if (gone) URL.revokeObjectURL(gone.previewUrl);
    setItems((xs) => xs.filter((a) => a.key !== key));
  }, [items]);

  /** After sending: the previews now belong to the sent message, so they are not revoked. */
  const clear = useCallback(() => setItems([]), []);

  return {
    items,
    add,
    remove,
    clear,
    uploading: items.some((a) => a.status === 'uploading'),
    failed: items.some((a) => a.status === 'error'),
    ready: items.filter((a): a is Attachment & { mediaId: string } => a.status === 'ready' && Boolean(a.mediaId)),
  };
}
