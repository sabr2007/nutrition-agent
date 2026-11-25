import Link from 'next/link';

const LINKS = [
  { href: '/report', title: 'Отчёт за неделю', hint: 'вес 7д, дни в плане, белок, срывы', glyph: '▤' },
  { href: '/history', title: 'История', hint: 'все дни, текстовые графики', glyph: '≡' },
  { href: '/memory', title: 'Память и навыки', hint: 'что агент помнит — можно править', glyph: '◇' },
  { href: '/settings', title: 'Настройки', hint: 'цели, Telegram, браслет, напоминания, жиры, пароль', glyph: '⚙' },
];

// Kept reachable (not in the tab bar) until the Telegram bot is verified in prod by its owner (D30):
// if the bot fails in the morning, the old chat and manual logging still work.
const FALLBACK = [
  { href: '/chat', title: 'Старый чат', hint: 'запасной вход, пока бот не проверен' },
  { href: '/log', title: 'Ручная запись', hint: 'запасной вход, пока бот не проверен' },
];

export default function MorePage() {
  return (
    <main className="px-4 pt-[calc(14px+var(--safe-top))]">
      <header className="px-1">
        <p className="label">ещё</p>
        <h1 className="font-display mt-1 text-[length:var(--text-display)] leading-none">Всё остальное</h1>
      </header>
      <ul className="mt-5 space-y-2">
        {LINKS.map((l) => (
          <li key={l.href}>
            <Link href={l.href} className="press surface flex items-center gap-4 p-4">
              <span className="flex h-10 w-10 items-center justify-center rounded-full bg-linen font-mono">{l.glyph}</span>
              <span className="flex-1">
                <span className="block font-medium">{l.title}</span>
                <span className="text-sm text-ink-3">{l.hint}</span>
              </span>
              <span className="font-mono text-ink-3">→</span>
            </Link>
          </li>
        ))}
      </ul>
      <p className="label mt-8 px-1">запасной вход</p>
      <ul className="mt-2 space-y-1">
        {FALLBACK.map((l) => (
          <li key={l.href}>
            <Link href={l.href} className="press flex items-center justify-between px-1 py-2 text-sm text-ink-2">
              <span>{l.title} <span className="text-ink-3">· {l.hint}</span></span>
              <span className="font-mono text-ink-3">→</span>
            </Link>
          </li>
        ))}
      </ul>
      <pre className="ascii mt-10 text-center text-[10px] text-ink-3" aria-hidden>{'┌─ рядом ─┐\n└─  v2   ─┘'}</pre>
    </main>
  );
}
