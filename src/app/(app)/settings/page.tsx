'use client';

import { useEffect, useState } from 'react';
import useSWR from 'swr';
import { useRouter } from 'next/navigation';
import { supabaseBrowser, accessToken } from '@/lib/supabase/browser';
import { api, fetcher } from '@/lib/client/api';
import { writeSession } from '@/lib/client/session';
import { useSession } from '@/components/auth/AuthGate';
import { useToast } from '@/components/ui/Toast';
import { enablePush, pushState, type PushState } from '@/lib/client/push';
import type { Goal } from '@/lib/nutrition/types';
import { CoachLimitsCard } from '@/components/settings/CoachLimitsCard';
import { GoogleHealthCard } from '@/components/settings/GoogleHealthCard';

type Profile = { display_name: string | null; day_boundary_minutes: number; quiet_start: string; quiet_end: string; training: { days: number[]; start: string; end: string } };
type Rule = { id: string; key: string; title: string; kind: string; enabled: boolean; at_time: string | null };
type Providers = { chatgpt: { status: string; updated_at: string | null }; models: Record<string, string>; usage_7d: Record<string, { calls: number; errors: number; cost: number }> };

const TASK_LABEL: Record<string, string> = { agent: 'чат и агент', deep: 'думать дольше', vision: 'фото и этикетки', parse: 'разбор текста', compose: 'тексты пушей' };

const DAYS = ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'];

export default function SettingsPage() {
  const session = useSession();
  const toast = useToast();
  const router = useRouter();
  const sb = supabaseBrowser();
  const uid = session!.user.id;
  const { data: profile, mutate: mutateProfile } = useSWR<Profile>('profile', async () => (await sb.from('profiles').select('display_name, day_boundary_minutes, quiet_start, quiet_end, training').eq('user_id', uid).single()).data as Profile);
  const { data: goals, mutate: mutateGoals } = useSWR<Goal[]>('goals', async () => ((await sb.from('goals').select('*').eq('is_current', true).order('starts_on')).data ?? []) as Goal[]);
  const { data: rules, mutate: mutateRules } = useSWR<Rule[]>('rules', async () => ((await sb.from('reminder_rules').select('id, key, title, kind, enabled, at_time').order('sort_order')).data ?? []) as Rule[]);
  const { data: providers } = useSWR<Providers>('/api/providers', fetcher);
  const [push, setPush] = useState<PushState | null>(null);
  const [pwd, setPwd] = useState({ a: '', b: '' });
  const [goalEdit, setGoalEdit] = useState<Goal | null>(null);

  useEffect(() => { void pushState().then(setPush); }, []);

  async function saveProfile(patch: Partial<Profile>) {
    const { error } = await sb.from('profiles').update(patch).eq('user_id', uid);
    toast({ text: error ? 'Не сохранилось' : 'Сохранено', tone: error ? 'error' : 'default' });
    mutateProfile();
  }

  async function saveGoal(g: Goal) {
    if (g.kcal_min < 1500 || g.kcal_max < g.kcal_min) { toast({ text: 'Калории: минимум 1500 и max ≥ min', tone: 'error' }); return; }
    const original = goals?.find((x) => x.id === g.id);
    if (!original) return;
    const { id: _id, ...rest } = g as Goal & Record<string, unknown>;
    delete (rest as Record<string, unknown>).created_at;
    const { error: e1 } = await sb.from('goals').update({ is_current: false }).eq('id', g.id);
    const { error: e2 } = await sb.from('goals').insert({ ...rest, user_id: uid, supersedes_id: g.id, is_current: true, created_by: 'user' });
    toast({ text: e1 || e2 ? 'Не сохранилось' : 'Цель обновлена (старая версия в истории)', tone: e1 || e2 ? 'error' : 'default' });
    setGoalEdit(null);
    mutateGoals();
  }

  async function changePassword() {
    if (pwd.a.length < 12) { toast({ text: 'Минимум 12 символов', tone: 'error' }); return; }
    if (pwd.a !== pwd.b) { toast({ text: 'Пароли не совпадают', tone: 'error' }); return; }
    const { error } = await sb.auth.updateUser({ password: pwd.a });
    toast({ text: error ? `Ошибка: ${error.message}` : 'Пароль изменён', tone: error ? 'error' : 'default' });
    if (!error) setPwd({ a: '', b: '' });
  }

  async function exportData() {
    const token = await accessToken();
    const res = await fetch('/api/export', { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) { toast({ text: 'Экспорт не удался', tone: 'error' }); return; }
    const blob = await res.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `ryadom-export-${new Date().toISOString().slice(0, 10)}.zip`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  return (
    <main className="space-y-6 px-4 pb-10 pt-[calc(14px+var(--safe-top))]">
      <header className="px-1">
        <p className="label">настройки</p>
        <h1 className="font-display mt-1 text-[length:var(--text-display)] leading-none">Как всё работает</h1>
      </header>

      <Section title="Цели">
        {(goals ?? []).map((g) => (
          <div key={g.id} className="surface p-4">
            {goalEdit?.id === g.id ? (
              <GoalForm goal={goalEdit} onChange={setGoalEdit} onSave={() => saveGoal(goalEdit)} onCancel={() => setGoalEdit(null)} />
            ) : (
              <>
                <div className="flex items-baseline justify-between">
                  <p className="font-medium">{g.name}</p>
                  <button onClick={() => setGoalEdit(g)} className="press font-mono text-xs underline decoration-dotted">изменить</button>
                </div>
                <p className="mt-1 font-mono text-xs text-ink-2">{g.starts_on} → {g.ends_on ?? '…'}</p>
                <p className="mt-2 font-mono text-sm">{g.kcal_min}–{g.kcal_max} ккал · б {g.protein_min_g}–{g.protein_max_g ?? '…'} · ж {g.fat_min_g}–{g.fat_max_g ?? '…'} · у {g.carbs_min_g ?? '…'}–{g.carbs_max_g ?? '…'}</p>
                <p className="mt-1 text-xs text-ink-3">Нижний порог {g.kcal_floor} ккал — ниже агент не советует никогда.</p>
              </>
            )}
          </div>
        ))}
      </Section>

      {profile && (
        <Section title="Расписание">
          <div className="surface space-y-4 p-4">
            <div>
              <p className="label">дни тренировок</p>
              <div className="mt-2 flex gap-1.5">
                {DAYS.map((d, i) => {
                  const on = profile.training.days.includes(i + 1);
                  return <button key={d} aria-pressed={on} onClick={() => saveProfile({ training: { ...profile.training, days: on ? profile.training.days.filter((x) => x !== i + 1) : [...profile.training.days, i + 1].sort() } })} className={`press h-10 w-10 rounded-full border font-mono text-xs ${on ? 'border-ink bg-ink text-linen' : 'border-rule'}`}>{d}</button>;
                })}
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <TimeField label="зал с" value={profile.training.start} onChange={(v) => saveProfile({ training: { ...profile.training, start: v } })} />
              <TimeField label="до" value={profile.training.end} onChange={(v) => saveProfile({ training: { ...profile.training, end: v } })} />
              <TimeField label="тихие часы с" value={profile.quiet_start.slice(0, 5)} onChange={(v) => saveProfile({ quiet_start: v })} />
              <TimeField label="до" value={profile.quiet_end.slice(0, 5)} onChange={(v) => saveProfile({ quiet_end: v })} />
            </div>
            <label className="block">
              <span className="label">день заканчивается в</span>
              <select value={profile.day_boundary_minutes} onChange={(e) => saveProfile({ day_boundary_minutes: Number(e.target.value) })} className="mt-1 w-full rounded-xl border border-rule bg-paper px-3 py-2.5">
                {[0, 120, 180, 240, 300, 360].map((m) => <option key={m} value={m}>{String(m / 60).padStart(2, '0')}:00 — еда до этого времени считается вчерашней</option>)}
              </select>
            </label>
          </div>
        </Section>
      )}

      <Section title="Telegram и проактивность">
        <CoachLimitsCard userId={uid} />
      </Section>

      <Section title="Напоминания">
        <div className="surface p-4">
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm text-ink-2">Напоминания приходят в Telegram с кнопками. Пуши — запасной канал, пока бот не привязан: {push === 'enabled' ? 'включены на этом устройстве.' : push === 'needs-install' ? 'нужна установка на экран «Домой».' : push === 'denied' ? 'запрещены в настройках iOS.' : 'выключены.'}</p>
            {push === 'enabled' ? (
              <button onClick={async () => { const r = await api<{ delivered: number }>('/api/push/test', { body: {} }); toast({ text: r.delivered ? 'Отправил тестовый пуш' : 'Не доставлено — проверь разрешения' }); }} className="press shrink-0 rounded-full border border-ink px-4 py-2 text-sm">Тест</button>
            ) : push === 'default' ? (
              <button onClick={async () => setPush(await enablePush())} className="press shrink-0 rounded-full bg-ink px-4 py-2 text-sm text-linen">Включить</button>
            ) : null}
          </div>
        </div>
        <ul className="surface mt-2 divide-y divide-dashed divide-rule">
          {(rules ?? []).map((r) => (
            <li key={r.id} className="flex min-h-[52px] items-center gap-3 px-4">
              <span className="w-12 font-mono text-xs text-ink-3">{r.at_time?.slice(0, 5) ?? 'по ситуации'}</span>
              <span className="flex-1 text-sm">{r.title}{r.kind === 'agent' ? <span className="label ml-2">агент</span> : null}</span>
              <button role="switch" aria-checked={r.enabled} onClick={async () => { await sb.from('reminder_rules').update({ enabled: !r.enabled }).eq('id', r.id); mutateRules(); }}
                className={`press rounded-full border px-3 py-1 font-mono text-xs ${r.enabled ? 'border-ink bg-ink text-linen' : 'border-rule text-ink-3'}`}>{r.enabled ? 'вкл' : 'выкл'}</button>
            </li>
          ))}
        </ul>
      </Section>

      <Section title="Модели">
        <div className="surface p-4 text-sm">
          <p className="flex justify-between font-mono text-xs">
            <span>подписка ChatGPT</span>
            <span className={providers?.chatgpt.status === 'connected' ? 'text-ok' : 'text-over'}>{providers ? (providers.chatgpt.status === 'connected' ? 'подключена' : 'нужно войти заново') : '…'}</span>
          </p>
          <ul className="mt-2 space-y-1">
            {providers && Object.entries(providers.models).map(([task, model]) => <li key={task} className="flex justify-between font-mono text-xs"><span className="text-ink-2">{TASK_LABEL[task] ?? task}</span><span>{model}</span></li>)}
          </ul>
          {providers && Object.keys(providers.usage_7d).length > 0 && (
            <>
              <p className="label mt-3">вызовы за 7 дней</p>
              <ul className="mt-1 space-y-0.5 font-mono text-[11px] text-ink-2">
                {Object.entries(providers.usage_7d).map(([k, u]) => <li key={k} className="flex justify-between"><span className="truncate pr-2">{k}</span><span>{u.calls} · ошибок {u.errors} · ${u.cost.toFixed(3)}</span></li>)}
              </ul>
            </>
          )}
          <p className="mt-3 text-xs text-ink-3">Всё работает только на подписке ChatGPT, без запасных провайдеров. Голос расшифровывает Whisper (у подписки нет распознавания речи). Повторный вход — команда в docs/SETUP.md.</p>
        </div>
      </Section>

      <Section title="Браслет: Google Health">
        <GoogleHealthCard />
      </Section>

      <Section title="Запасной путь: Apple «Команды»">
        <HealthImport />
      </Section>

      <Section title="Аккаунт">
        <div className="surface space-y-3 p-4">
          <p className="text-sm text-ink-2">{session!.user.email}</p>
          <input type="password" autoComplete="new-password" placeholder="Новый пароль (12+ символов)" value={pwd.a} onChange={(e) => setPwd({ ...pwd, a: e.target.value })} className="w-full rounded-xl border border-rule bg-paper px-3 py-3" />
          <input type="password" autoComplete="new-password" placeholder="Повтори пароль" value={pwd.b} onChange={(e) => setPwd({ ...pwd, b: e.target.value })} className="w-full rounded-xl border border-rule bg-paper px-3 py-3" />
          <button onClick={changePassword} className="press w-full rounded-full border border-ink py-3">Сменить пароль</button>
          <button onClick={exportData} className="press w-full rounded-full border border-rule py-3">Экспорт всех данных (ZIP с CSV)</button>
          <button onClick={async () => { await sb.auth.signOut(); writeSession(null); if ('caches' in window) { for (const k of await caches.keys()) if (k.startsWith('data-')) await caches.delete(k); } router.replace('/login'); }} className="press w-full py-2 text-sm text-over">Выйти</button>
        </div>
      </Section>
    </main>
  );
}

function HealthImport() {
  const [token, setToken] = useState<string | null>(null);
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  return (
    <div className="surface space-y-3 p-4 text-sm text-ink-2">
      <p>PWA не может читать Здоровье напрямую. Автоматизация «Команд» раз в день шлёт шаги и сон сюда.</p>
      {token ? (
        <div className="space-y-2">
          <p className="label">токен (показывается один раз)</p>
          <code className="block break-all rounded-xl bg-paper p-2 font-mono text-xs text-ink">{token}</code>
          <ol className="list-decimal space-y-1 pl-5 text-xs">
            <li>Команды → Автоматизация → «Будильник остановлен» (или время подъёма) → Новая команда.</li>
            <li>«Найти образцы здоровья»: Шаги, сегодня → «Вычислить статистику» → сумма.</li>
            <li>«Найти образцы здоровья»: Анализ сна, вчера → длительность в часах.</li>
            <li>«Словарь»: steps, sleep_hours → «Получить содержимое URL»: POST {origin}/api/ingest/health, заголовок Authorization: Bearer токен, тело JSON.</li>
            <li>Выключи «Спрашивать перед запуском».</li>
          </ol>
        </div>
      ) : (
        <button onClick={async () => setToken((await api<{ token: string }>('/api/ingest/token', { body: {} })).token)} className="press w-full rounded-full border border-ink py-3">Создать токен для «Команд»</button>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="mb-2 px-1 font-display text-xl">{title}</h2>
      {children}
    </section>
  );
}

function TimeField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <label className="block">
      <span className="label">{label}</span>
      <input type="time" defaultValue={value} onBlur={(e) => e.target.value && e.target.value !== value && onChange(e.target.value)} className="mt-1 w-full rounded-xl border border-rule bg-paper px-3 py-2.5 font-mono" />
    </label>
  );
}

function GoalForm({ goal, onChange, onSave, onCancel }: { goal: Goal; onChange: (g: Goal) => void; onSave: () => void; onCancel: () => void }) {
  const fields: [keyof Goal, string][] = [['kcal_min', 'ккал от'], ['kcal_max', 'ккал до'], ['protein_min_g', 'белок от'], ['protein_max_g', 'белок до'], ['fat_min_g', 'жиры от'], ['fat_max_g', 'жиры до'], ['carbs_min_g', 'углев. от'], ['carbs_max_g', 'углев. до']];
  return (
    <div>
      <p className="font-medium">{goal.name}</p>
      <div className="mt-3 grid grid-cols-2 gap-2">
        {fields.map(([k, label]) => (
          <label key={k} className="block">
            <span className="label">{label}</span>
            <input inputMode="numeric" value={String(goal[k] ?? '')} onChange={(e) => onChange({ ...goal, [k]: e.target.value === '' ? null : Number(e.target.value) })} className="mt-1 w-full rounded-xl border border-rule bg-paper px-3 py-2 font-mono" />
          </label>
        ))}
      </div>
      <div className="mt-3 flex gap-2">
        <button onClick={onSave} className="press rounded-full bg-ink px-5 py-2 text-sm text-linen">Сохранить</button>
        <button onClick={onCancel} className="press px-3 text-sm text-ink-3">Отмена</button>
      </div>
    </div>
  );
}
