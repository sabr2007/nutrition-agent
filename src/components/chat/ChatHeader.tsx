'use client';

import Link from 'next/link';
import type { TodayResponse } from '@/lib/client/types';
import { fmt } from '@/lib/client/format';
import { MenuIcon } from '@/components/ui/icons';

type Props = { today: TodayResponse | undefined; onMenu: () => void };

/**
 * ChatGPT's top bar: round menu button, a segmented pill in the middle (here: the chat itself
 * and today's numbers, which change as the agent logs food) and a balancing slot on the right.
 */
export function ChatHeader({ today, onMenu }: Props) {
  const s = today?.summary;
  const kcal = s ? `${fmt(s.totals.kcal)}${s.goal ? ` / ${fmt(s.goal.kcal_max)}` : ''} ккал` : 'сегодня';
  return (
    <header className="relative z-10 grid grid-cols-[40px_1fr_40px] items-center gap-3 px-4 pb-1.5 pt-[calc(10px+var(--safe-top))]">
      <button type="button" onClick={onMenu} aria-label="Меню"
        className="press flex h-10 w-10 items-center justify-center rounded-full border border-rule/70 bg-card/85 text-ink shadow-[var(--shadow-card)] backdrop-blur">
        <MenuIcon size={22} />
      </button>
      <nav aria-label="Чат и день" className="flex justify-center">
        <div className="flex items-center gap-0.5 rounded-full border border-rule/70 bg-card/85 p-1 shadow-[var(--shadow-card)] backdrop-blur">
          <span aria-current="page" className="rounded-full bg-linen-deep px-4 py-1.5 text-[15px] font-medium">Чат</span>
          <Link href="/" className="press rounded-full px-3.5 py-1.5 text-[14px] text-ink-2">
            <span className="tabular font-mono text-[13px]">{kcal}</span>
          </Link>
        </div>
      </nav>
      <span aria-hidden className="h-10 w-10" />
    </header>
  );
}
