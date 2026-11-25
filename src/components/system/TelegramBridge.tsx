'use client';

import { usePathname, useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { loadSdk, webApp } from '@/lib/client/telegram';

// Inside Telegram: the app takes the whole height, keeps its own linen palette for the client's
// header and background, swaps its «back» arrows for Telegram's BackButton and takes the safe
// areas from Telegram (D30). Outside Telegram this renders nothing and does nothing.

const LINEN = '#efede4';
/** Tab roots: no back button there. */
const ROOTS = new Set(['/', '/body', '/more']);

export function TelegramBridge() {
  const path = usePathname();
  const router = useRouter();

  useEffect(() => {
    void loadSdk().then((w) => {
      if (!w) return;
      document.documentElement.classList.add('tg');
      w.ready();
      w.expand();
      if (w.isVersionAtLeast('7.7')) w.disableVerticalSwipes?.();
      if (w.isVersionAtLeast('6.1')) { w.setHeaderColor(LINEN); w.setBackgroundColor(LINEN); }
      if (w.isVersionAtLeast('7.10')) w.setBottomBarColor?.(LINEN);
    });
  }, []);

  useEffect(() => {
    const w = webApp();
    if (!w || !w.isVersionAtLeast('6.1')) return;
    const back = () => router.back();
    if (ROOTS.has(path)) { w.BackButton.hide(); return; }
    w.BackButton.show();
    w.BackButton.onClick(back);
    return () => w.BackButton.offClick(back);
  }, [path, router]);

  return null;
}
