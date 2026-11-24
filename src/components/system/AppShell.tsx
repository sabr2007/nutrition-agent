'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, type ReactNode } from 'react';
import { resubscribeIfGranted } from '@/lib/client/push';
import { ToastProvider } from '@/components/ui/Toast';
import { PlusIcon } from '@/components/ui/icons';

const NAV = [
  { href: '/', label: 'Сегодня', glyph: '◐' },
  { href: '/chat', label: 'Чат', glyph: '◇' },
  { href: '/body', label: 'Тело', glyph: '▤' },
  { href: '/more', label: 'Ещё', glyph: '⋯' },
];

/** Full-screen surfaces (chat, log) bring their own navigation. */
const FULL_SCREEN = ['/log', '/chat'];

export function AppShell({ children }: { children: ReactNode }) {
  const path = usePathname();
  const hideNav = FULL_SCREEN.some((p) => path.startsWith(p));
  // iOS can rotate push subscriptions silently: re-save on every launch (no prompt).
  useEffect(() => { void resubscribeIfGranted().catch(() => undefined); }, []);
  return (
    <ToastProvider>
      <div className={`mx-auto w-full max-w-md ${hideNav ? '' : 'pb-[calc(var(--nav-h)+var(--safe-bottom)+24px)]'}`}>{children}</div>
      {!hideNav && (
        <nav aria-label="Основная навигация" className="fixed inset-x-0 bottom-0 z-30">
          <div className="mx-auto max-w-md px-5 pb-[calc(8px+var(--safe-bottom))]">
            <div className="grid h-[var(--nav-h)] grid-cols-5 items-center rounded-[22px] border border-rule bg-card/90 px-1.5 shadow-[var(--shadow-float)] backdrop-blur-md">
              {NAV.slice(0, 2).map((n) => <NavItem key={n.href} {...n} active={isActive(path, n.href)} />)}
              <div className="flex justify-center">
                <Link href="/log" aria-label="Записать еду" className="press flex h-11 w-11 items-center justify-center rounded-full bg-ink text-linen shadow-[var(--shadow-card)]">
                  <PlusIcon size={22} strokeWidth={2.2} />
                </Link>
              </div>
              {NAV.slice(2).map((n) => <NavItem key={n.href} {...n} active={isActive(path, n.href)} />)}
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
