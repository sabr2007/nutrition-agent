'use client';

// The Telegram Mini App bridge (D30). The official SDK (telegram.org/js/telegram-web-app.js) is
// loaded only inside Telegram; the launch data is also read straight from the URL hash so sign-in
// does not wait for the script. Outside Telegram everything here is a no-op.

type Inset = { top: number; bottom: number; left: number; right: number };
export type TgWebApp = {
  initData: string;
  version: string;
  platform: string;
  colorScheme: 'light' | 'dark';
  isVersionAtLeast(v: string): boolean;
  ready(): void;
  expand(): void;
  disableVerticalSwipes?(): void;
  setHeaderColor(color: string): void;
  setBackgroundColor(color: string): void;
  setBottomBarColor?(color: string): void;
  BackButton: { show(): void; hide(): void; onClick(cb: () => void): void; offClick(cb: () => void): void };
  HapticFeedback: { impactOccurred(s: 'light' | 'medium' | 'heavy' | 'rigid' | 'soft'): void; notificationOccurred(t: 'error' | 'success' | 'warning'): void; selectionChanged(): void };
  openLink(url: string, opts?: { try_instant_view?: boolean }): void;
  onEvent(e: string, cb: () => void): void;
  offEvent(e: string, cb: () => void): void;
  safeAreaInset?: Inset;
  contentSafeAreaInset?: Inset;
};

declare global {
  interface Window { Telegram?: { WebApp?: TgWebApp } }
}

export const SDK_URL = 'https://telegram.org/js/telegram-web-app.js?65';
const INIT_KEY = 'tg-init-data';

/** Launch data from the URL hash (first load) or this tab's session (after navigation). */
export function launchInitData(): string | null {
  if (typeof window === 'undefined') return null;
  const fromSdk = window.Telegram?.WebApp?.initData;
  if (fromSdk) return fromSdk;
  try {
    const hash = new URLSearchParams(window.location.hash.slice(1)).get('tgWebAppData');
    if (hash) {
      sessionStorage.setItem(INIT_KEY, hash);
      return hash;
    }
    return sessionStorage.getItem(INIT_KEY);
  } catch {
    return null;
  }
}

export const inTelegram = (): boolean => Boolean(launchInitData());

export function webApp(): TgWebApp | null {
  if (typeof window === 'undefined') return null;
  const w = window.Telegram?.WebApp;
  return w && w.initData ? w : null;
}

let loading: Promise<TgWebApp | null> | null = null;

/** Loads the SDK once (inside Telegram only) and resolves with the WebApp object. */
export function loadSdk(): Promise<TgWebApp | null> {
  if (!inTelegram()) return Promise.resolve(null);
  if (webApp()) return Promise.resolve(webApp());
  loading ??= new Promise((resolve) => {
    const s = document.createElement('script');
    s.src = SDK_URL;
    s.async = true;
    s.onload = () => resolve(webApp());
    s.onerror = () => resolve(null);
    document.head.appendChild(s);
  });
  return loading;
}

export type Haptic = 'success' | 'error' | 'warning' | 'light' | 'selection';

/** A tap of feedback on writes and deletes (Telegram 6.1+). */
export function haptic(kind: Haptic): void {
  const w = webApp();
  if (!w || !w.isVersionAtLeast('6.1')) return;
  try {
    if (kind === 'selection') w.HapticFeedback.selectionChanged();
    else if (kind === 'light') w.HapticFeedback.impactOccurred('light');
    else w.HapticFeedback.notificationOccurred(kind);
  } catch {
    // feedback is a nicety
  }
}

/** Google blocks OAuth in embedded webviews: inside Telegram, links leave through the client. */
export function openExternal(url: string): void {
  const w = webApp();
  if (w) w.openLink(url);
  else window.location.assign(url);
}
