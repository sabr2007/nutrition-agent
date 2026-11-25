'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, type ReactNode } from 'react';
import { resubscribeIfGranted } from '@/lib/client/push';
import { ToastProvider } from '@/components/ui/Toast';
import { TelegramBridge } from './TelegramBridge';

// v2 (D30): three tabs. Logging and the coach live in the Telegram chat; the Mini App shows the day.
const NAV = [
  { href: '/', label: 'Сегодня', glyph: '◐' },
  { href: '/body', label: 'Тело', glyph: '▤' },
  { href: '/more', label: 'Ещё', glyph: '⋯' },
];

/** Full-screen surfaces (the old chat and log screens, kept until the bot is verified) bring their own navigation. */
const FULL_SCREEN = ['/log', '/chat'];

export function AppShell({ children }: { children: ReactNode }) {
  const path = usePathname();
  const hideNav = FULL_SCREEN.some((p) => path.startsWith(p));
  // iOS can rotate push subscriptions silently: re-save on every launch (no prompt).
  useEffect(() => { void resubscribeIfGranted().catch(() => undefined); }, []);
  return (
    <ToastProvider>
      <TelegramBridge />
      <div className={`mx-auto w-full max-w-md ${hideNav ? '' : 'pb-[calc(var(--nav-h)+var(--safe-bottom)+24px)]'}`}>{children}</div>
      {!hideNav && (
        <nav aria-label="Основная навигация" className="fixed inset-x-0 bottom-0 z-30">
          <div className="mx-auto max-w-md px-5 pb-[calc(8px+var(--safe-bottom))]">
            <div className="nav-surface grid h-[var(--nav-h)] grid-cols-3 items-center rounded-[22px] border border-rule bg-card/90 px-1.5 shadow-[var(--shadow-float)] backdrop-blur-md">
              {NAV.map((n) => <NavItem key={n.href} {...n} active={isActive(path, n.href)} />)}
            </div>
          </div>
        </nav>
      )}
    </ToastProvider>
  );
}

function isActive(path: string, href: string) {
  return href === '/' ? path === '/' : path.startsWith(href);
}

function NavItem({ href, label, glyph, active }: { href: string; label: string; glyph: string; active: boolean }) {
  return (
    <Link href={href} aria-current={active ? 'page' : undefined}
      className={`press flex flex-col items-center gap-0.5 rounded-2xl py-1 ${active ? 'text-ink' : 'text-ink-3'}`}>
      <span className="font-mono text-[15px] leading-none" aria-hidden>{glyph}</span>
      <span className={`text-[10.5px] leading-tight ${active ? 'font-semibold' : ''}`}>{label}</span>
    </Link>
  );
}
