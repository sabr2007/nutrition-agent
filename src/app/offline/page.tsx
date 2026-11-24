export default function Offline() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center px-6 text-center">
      <pre className="ascii text-ink-3" aria-hidden>{'┌────────────┐\n│  нет сети  │\n└────────────┘'}</pre>
      <p className="mt-4 text-ink-2">Записи шаблонами сохраняются и отправятся, когда связь вернётся.</p>
    </main>
  );
}
