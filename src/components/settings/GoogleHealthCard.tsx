'use client';

import useSWR from 'swr';
import { api, fetcher } from '@/lib/client/api';
import { openExternal } from '@/lib/client/telegram';
import { useToast } from '@/components/ui/Toast';

type Status = { configured: boolean; status: 'none' | 'connected' | 'expired' | 'revoked' | 'error'; last_sync_at: string | null; last_error: string | null; refresh_expires_at: string | null };

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');

/** Google Health (D28): connect in the external browser, status, last sync, disconnect. */
export function GoogleHealthCard() {
  const toast = useToast();
  const { data, mutate } = useSWR<Status>('/api/health/google', fetcher);

  async function connect() {
    try {
      const { url } = await api<{ url: string }>('/api/health/google/start', { body: {} });
      openExternal(url);
    } catch (e) {
      toast({ text: (e as Error).message, tone: 'error' });
    }
  }
  async function syncNow() {
    const r = await api<{ ok: boolean; days: number; sleeps: number; workouts: number; error?: string }>('/api/health/google/sync', { body: {} }).catch((e: Error) => ({ ok: false, error: e.message, days: 0, sleeps: 0, workouts: 0 }));
    toast({ text: r.ok ? `Синхронизировано: дней ${r.days}, ночей ${r.sleeps}, тренировок ${r.workouts}` : `Не вышло: ${r.error}`, tone: r.ok ? 'default' : 'error' });
    void mutate();
  }
  async function disconnect() {
    await api('/api/health/google', { method: 'DELETE' }).catch(() => undefined);
    toast({ text: 'Google Health отключён' });
    void mutate();
  }

  if (!data) return <div className="surface p-4 text-sm text-ink-3">…</div>;
  if (!data.configured) return <div className="surface p-4 text-sm text-ink-2">OAuth-клиент Google ещё не настроен (шаги в docs/BLOCKERS.md).</div>;
  const connected = data.status === 'connected';
  return (
    <div className="surface space-y-3 p-4 text-sm">
      <p className="flex justify-between font-mono text-xs">
        <span>браслет</span>
        <span className={connected ? 'text-ok' : 'text-ink-3'}>{connected ? 'подключён' : data.status === 'expired' ? 'нужно подключить заново' : 'не подключён'}</span>
      </p>
      {connected && <p className="font-mono text-xs text-ink-2">последняя синхронизация: {when(data.last_sync_at)}</p>}
      {data.last_error && <p className="font-mono text-xs text-over">ошибка: {data.last_error}</p>}
      {connected && data.refresh_expires_at && <p className="text-xs text-ink-3">В тестовом режиме Google доступ живёт 7 дней — до {when(data.refresh_expires_at)}; потом подключи заново.</p>}
      <div className="flex gap-2">
        {connected ? (
          <>
            <button onClick={syncNow} className="press flex-1 rounded-full border border-ink py-2.5">Синхронизировать</button>
            <button onClick={disconnect} className="press rounded-full px-4 py-2.5 text-over">Отключить</button>
          </>
        ) : (
          <button onClick={connect} className="press w-full rounded-full bg-ink py-3 text-linen">Подключить Google Health</button>
        )}
      </div>
      {!connected && <p className="text-xs text-ink-3">Откроется браузер: Google не пускает вход внутри Telegram. Перед этим войди тем же аккаунтом в приложение Google Health на телефоне.</p>}
    </div>
  );
}
