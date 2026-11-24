'use client';

import { useEffect } from 'react';
import { flushOutbox } from '@/lib/client/api';

export function ServiceWorker() {
  useEffect(() => {
    if ('serviceWorker' in navigator && process.env.NODE_ENV === 'production') {
      navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => undefined);
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
