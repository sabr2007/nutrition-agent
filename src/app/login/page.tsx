'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { supabaseBrowser } from '@/lib/supabase/browser';
import { isBackendConfigured } from '@/lib/env';

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const configured = isBackendConfigured();

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { error: err } = await supabaseBrowser().auth.signInWithPassword({ email: email.trim(), password });
    setBusy(false);
    if (err) {
      setError(err.message.includes('Invalid') ? 'Неверная почта или пароль' : 'Не получилось войти. Попробуй ещё раз.');
      return;
    }
    router.replace('/');
  }

  return (
    <main className="relative mx-auto flex min-h-dvh max-w-md flex-col justify-between px-6 pb-[calc(32px+var(--safe-bottom))] pt-[calc(48px+var(--safe-top))]">
      <div className="aura" aria-hidden />
      <header className="relative">
        <p className="label">рядом · v1</p>
        <h1 className="font-display mt-6 text-[length:var(--text-display)] leading-[1.05]">
          Спокойно.<br />Записали — и дальше.
        </h1>
        <p className="mt-4 max-w-[30ch] text-ink-2">Личный коуч по питанию: напомнит, запишет, поддержит. Без стыда и мотивационной воды.</p>
      </header>

      {configured ? (
        <form onSubmit={submit} className="surface framed relative mt-10 space-y-4 p-5">
          <label className="block">
            <span className="label">почта</span>
            <input type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)}
              className="mt-1 w-full rounded-[var(--radius-sm)] border border-rule bg-paper px-3 py-3 text-base outline-none focus:border-ink" />
          </label>
          <label className="block">
            <span className="label">пароль</span>
            <input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)}
              className="mt-1 w-full rounded-[var(--radius-sm)] border border-rule bg-paper px-3 py-3 text-base outline-none focus:border-ink" />
          </label>
          {error && <p role="alert" className="text-sm text-over">{error}</p>}
          <button type="submit" disabled={busy} className="press w-full rounded-full bg-ink py-4 font-medium text-linen disabled:opacity-60">
            {busy ? 'Вхожу…' : 'Войти'}
          </button>
          <p className="text-center text-xs text-ink-3">Регистрация закрыта — это личное приложение.</p>
        </form>
      ) : (
        <div className="surface relative mt-10 p-5 text-sm text-ink-2">
          <p className="label mb-2">бэкенд не подключён</p>
          Supabase-проект ещё не создан. Шаг для владельца описан в <code>docs/BLOCKERS.md</code>.
        </div>
      )}
      <pre className="ascii relative mt-8 text-center text-[10px] text-ink-3" aria-hidden>{'·  ·  ·  ○  ·  ·  ·'}</pre>
    </main>
  );
}
