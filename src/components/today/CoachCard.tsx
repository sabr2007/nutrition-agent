'use client';

import Link from 'next/link';
import { api } from '@/lib/client/api';
import type { TodayResponse } from '@/lib/client/types';

export function CoachCard({ coach, notification, onChange }: { coach: TodayResponse['coach']; notification: TodayResponse['notification']; onChange: () => void }) {
  async function react(action: 'done' | 'snoozed' | 'dismissed') {
    if (!notification) return;
    await api(`/api/notifications/${notification.id}`, { body: { action } });
    onChange();
  }
  if (notification) {
    return (
      <section aria-label="Напоминание" className="surface framed fade-in mt-4 p-4">
        <p className="label">напоминание</p>
        <p className="mt-1">{notification.body}</p>
        <div className="mt-3 flex flex-wrap gap-2">
          <button onClick={() => react('done')} className="press rounded-full bg-ink px-4 py-2 text-sm text-linen">Готово</button>
          <button onClick={() => react('snoozed')} className="press rounded-full border border-rule px-4 py-2 text-sm">Через 15 мин</button>
          <button onClick={() => react('dismissed')} className="press rounded-full px-3 py-2 text-sm text-ink-3">Скрыть</button>
        </div>
      </section>
    );
  }
  if (!coach) return null;
  return (
    <Link href="/chat" className="press surface mt-4 flex gap-3 p-4">
      <span className="font-mono text-lg" aria-hidden>◇</span>
      <span className="min-w-0 flex-1">
        <span className="label">чат</span>
        <span className="mt-0.5 line-clamp-3 block text-sm text-ink-2">{coach.text}</span>
      </span>
    </Link>
  );
}
