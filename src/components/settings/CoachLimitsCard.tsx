'use client';

import useSWR from 'swr';
import { supabaseBrowser } from '@/lib/supabase/browser';
import { useToast } from '@/components/ui/Toast';

type Limits = {
  max_proactive_per_day: number; min_minutes_between_proactive: number; telegram_linked_at: string | null;
  settings: { fat_thresholds?: { meal_share?: number; satfat_share?: number; max_per_day?: number } } | null;
};

const MIN_GAP = 90;
const FAT_DEFAULTS = { meal_share: 0.4, satfat_share: 0.1, max_per_day: 3 };

/** Telegram link, the agent's limits (D29) and fat thresholds (D27). */
export function CoachLimitsCard({ userId }: { userId: string }) {
  const toast = useToast();
  const sb = supabaseBrowser();
  const { data, mutate } = useSWR<Limits>(['limits', userId], async () => (await sb.from('profiles').select('max_proactive_per_day, min_minutes_between_proactive, telegram_linked_at, settings').eq('user_id', userId).single()).data as Limits);

  async function save(patch: Partial<Limits>) {
    const { error } = await sb.from('profiles').update(patch).eq('user_id', userId);
    toast({ text: error ? 'Не сохранилось' : 'Сохранено', tone: error ? 'error' : 'default' });
    void mutate();
  }
  if (!data) return <div className="surface p-4 text-sm text-ink-3">…</div>;
  const fat = { ...FAT_DEFAULTS, ...(data.settings?.fat_thresholds ?? {}) };
  const saveFat = (k: keyof typeof FAT_DEFAULTS, v: number) => save({ settings: { ...(data.settings ?? {}), fat_thresholds: { ...fat, [k]: v } } });

  return (
    <div className="space-y-2">
      <div className="surface p-4 text-sm">
        <p className="flex justify-between font-mono text-xs">
          <span>telegram</span>
          <span className={data.telegram_linked_at ? 'text-ok' : 'text-over'}>{data.telegram_linked_at ? `привязан ${new Date(data.telegram_linked_at).toLocaleDateString('ru-RU')}` : 'не привязан — напиши боту /start <код>'}</span>
        </p>
        <p className="mt-2 text-xs text-ink-3">Тишина в боте: <span className="font-mono">/mute 3</span> — на 3 часа. Кнопка «🔕 Не сегодня» под напоминанием глушит его до конца дня.</p>
      </div>
      <div className="surface grid grid-cols-2 gap-3 p-4">
        <NumberField label="агент пишет в день, до" value={data.max_proactive_per_day} min={0} max={12} onSave={(v) => save({ max_proactive_per_day: v })} />
        <NumberField label="пауза, минут (≥ 90)" value={Math.max(MIN_GAP, data.min_minutes_between_proactive)} min={MIN_GAP} max={600} onSave={(v) => save({ min_minutes_between_proactive: Math.max(MIN_GAP, v) })} />
        <p className="col-span-2 text-xs text-ink-3">После трёх сообщений подряд без ответа или кнопки агент молчит, пока ты не напишешь. Твои собственные напоминания лимитом не режутся.</p>
      </div>
      <div className="surface grid grid-cols-3 gap-3 p-4">
        <NumberField label="приём, % жиров дня" value={Math.round(fat.meal_share * 100)} min={10} max={100} onSave={(v) => saveFat('meal_share', v / 100)} />
        <NumberField label="насыщ., % ккал" value={Math.round(fat.satfat_share * 100)} min={5} max={30} onSave={(v) => saveFat('satfat_share', v / 100)} />
        <NumberField label="предупр. в день" value={fat.max_per_day} min={0} max={10} onSave={(v) => saveFat('max_per_day', v)} />
        <p className="col-span-3 text-xs text-ink-3">Когда агент предупреждает о жирах: приём больше этой доли дневного потолка, насыщенные выше доли калорий, и не чаще стольких раз в день (0 — никогда).</p>
      </div>
    </div>
  );
}

function NumberField({ label, value, min, max, onSave }: { label: string; value: number; min: number; max: number; onSave: (v: number) => void }) {
  return (
    <label className="block">
      <span className="label">{label}</span>
      <input inputMode="numeric" defaultValue={value} key={value}
        onBlur={(e) => { const v = Number(e.target.value); if (Number.isFinite(v) && v >= min && v <= max && v !== value) onSave(v); else e.target.value = String(value); }}
        className="mt-1 w-full rounded-xl border border-rule bg-paper px-3 py-2 font-mono" />
    </label>
  );
}
