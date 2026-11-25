'use client';

import { useEffect } from 'react';
import { flushOutbox } from '@/lib/client/api';

export function ServiceWorker() {
  useEffect(() => {
    if ('serviceWorker' in navigator && process.env.NODE_ENV === 'production') {
      // A new deploy's worker takes over (skipWaiting + clients.claim): reload once onto the new shell.
      // Not on the first install (no controller yet), and never twice.
      const hadController = Boolean(navigator.serviceWorker.controller);
      let reloaded = false;
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (!hadController || reloaded) return;
        reloaded = true;
        window.location.reload();
      });
      navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' }).then((r) => r.update()).catch(() => undefined);
    }
    const onOnline = () => void flushOutbox().catch(() => undefined);
    window.addEventListener('online', onOnline);
    const onVisible = () => document.visibilityState === 'visible' && onOnline();
    document.addEventListener('visibilitychange', onVisible);
    onOnline();
    return () => {
      window.removeEventListener('online', onOnline);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);
  return null;
}
