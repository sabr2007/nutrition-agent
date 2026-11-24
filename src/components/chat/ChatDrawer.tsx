'use client';

import Link from 'next/link';
import { useEffect, useRef } from 'react';
import { CloseIcon } from '@/components/ui/icons';

const LINKS = [
  { href: '/', label: 'Сегодня', glyph: '◐' },
  { href: '/log', label: 'Записать еду', glyph: '+' },
  { href: '/body', label: 'Тело', glyph: '▤' },
  { href: '/report', label: 'Отчёт за неделю', glyph: '▥' },
  { href: '/history', label: 'История', glyph: '≡' },
  { href: '/memory', label: 'Память и навыки', glyph: '◇' },
  { href: '/settings', label: 'Настройки', glyph: '⚙' },
];

/** The chat hides the tab bar, so the menu button opens the app's sections (like ChatGPT's sidebar). */
export function ChatDrawer({ onClose }: { onClose: () => void }) {
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    panel.current?.querySelector<HTMLElement>('a')?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex" role="dialog" aria-modal="true" aria-label="Разделы">
      <div ref={panel} className="drawer-in flex h-full w-[min(82vw,320px)] flex-col bg-paper px-3 pb-[calc(16px+var(--safe-bottom))] pt-[calc(14px+var(--safe-top))] shadow-[var(--shadow-menu)]">
        <div className="flex items-center justify-between px-2">
          <p className="font-display text-2xl">Рядом</p>
          <button type="button" onClick={onClose} aria-label="Закрыть меню" className="press flex h-9 w-9 items-center justify-center rounded-full text-ink-2">
            <CloseIcon size={20} />
          </button>
        </div>
        <nav className="mt-4 flex-1">
          <ul className="space-y-0.5">
            {LINKS.map((l) => (
              <li key={l.href}>
                <Link href={l.href} onClick={onClose} className="press flex items-center gap-3 rounded-2xl px-2 py-2.5 hover:bg-linen focus-visible:bg-linen">
                  <span className="flex h-9 w-9 items-center justify-center rounded-full bg-linen font-mono text-sm" aria-hidden>{l.glyph}</span>
                  <span className="text-[16px]">{l.label}</span>
                </Link>
              </li>
            ))}
          </ul>
        </nav>
        <p className="px-2 text-xs leading-relaxed text-ink-3">Чат помнит контекст и сам записывает еду, вес и отметки в твой день.</p>
      </div>
      <button type="button" aria-label="Закрыть" className="flex-1 bg-ink/25 backdrop-blur-[2px]" onClick={onClose} />
    </div>
  );
}
