'use client';

import { useEffect, useState } from 'react';
import { enablePush, pushState, type PushState } from '@/lib/client/push';
import { useToast } from '@/components/ui/Toast';

export function PushPrompt() {
  const [state, setState] = useState<PushState | null>(null);
  const toast = useToast();
  useEffect(() => { void pushState().then(setState); }, []);
  if (!state || state === 'enabled' || state === 'unsupported') return null;
  if (state === 'needs-install') {
    return (
      <section className="surface mt-4 p-4 text-sm">
        <p className="label">напоминания</p>
        <p className="mt-1 text-ink-2">Чтобы приходили пуши на iPhone, установи приложение: <b>Поделиться → На экран «Домой»</b>, потом открой его с иконки.</p>
      </section>
    );
  }
  return (
    <section className="surface mt-4 flex items-center gap-3 p-4">
      <p className="flex-1 text-sm text-ink-2">{state === 'denied' ? 'Уведомления запрещены в настройках устройства.' : 'Включи напоминания — Рядом будет писать по контексту дня.'}</p>
      {state !== 'denied' && (
        <button onClick={async () => { const r = await enablePush(); setState(r); toast({ text: r === 'enabled' ? 'Напоминания включены' : 'Не получилось включить', tone: r === 'enabled' ? 'default' : 'error' }); }}
          className="press rounded-full bg-ink px-4 py-2 text-sm text-linen">Включить</button>
      )}
    </section>
  );
}
