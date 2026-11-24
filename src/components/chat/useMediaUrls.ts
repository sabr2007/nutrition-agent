'use client';

import useSWR from 'swr';
import { supabaseBrowser } from '@/lib/supabase/browser';

const SIGNED_TTL_S = 3600;
const REFRESH_EARLY_MS = 5 * 60_000;

/** Local previews of photos sent from this device (media_id → object URL): no flicker after sending. */
const localPreviews = new Map<string, string>();
const signed = new Map<string, { url: string; expiresAt: number }>();

export function rememberPreview(mediaId: string, url: string): void {
  localPreviews.set(mediaId, url);
}

export function localPreview(mediaId: string): string | undefined {
  return localPreviews.get(mediaId);
}

async function signPaths(paths: string[]): Promise<Record<string, string>> {
  const now = Date.now();
  const missing = paths.filter((p) => (signed.get(p)?.expiresAt ?? 0) - REFRESH_EARLY_MS < now);
  if (missing.length) {
    const { data } = await supabaseBrowser().storage.from('media').createSignedUrls(missing, SIGNED_TTL_S);
    for (const d of data ?? []) {
      if (d.path && d.signedUrl) signed.set(d.path, { url: d.signedUrl, expiresAt: now + SIGNED_TTL_S * 1000 });
    }
  }
  return Object.fromEntries(paths.flatMap((p) => (signed.has(p) ? [[p, signed.get(p)!.url]] : [])));
}

/** Short-lived signed URLs for photos in the private bucket (path → URL). */
export function useSignedUrls(paths: string[]): Record<string, string> {
  const key = paths.length ? `signed:${[...paths].sort().join('|')}` : null;
  const { data } = useSWR(key, () => signPaths(paths), { revalidateOnFocus: false, keepPreviousData: true });
  return data ?? {};
}
