'use client';

import { useEffect, useRef, useState } from 'react';
import { api, ApiError } from '@/lib/client/api';
import { prepareImage, uploadMedia } from '@/lib/client/media';
import { fmt } from '@/lib/client/format';
import { checkLabelNumbers } from '@/lib/nutrition/label-math';
import type { Food, FoodState } from '@/lib/nutrition/types';
import type { NormalizedLabel } from '@/lib/recognition/label';
import { useSession } from '@/components/auth/AuthGate';

export type LabelCreated = { food: Food; grams: number; recognitionId: string | null };

type Props = {
  /** Photo picked before the form opened (the tile on the log screen). */
  initialFile?: File | null;
  initialName?: string;
  /** Barcode that Open Food Facts did not know: saved with the product for the next scan. */
  barcode?: string | null;
  onCreated: (result: LabelCreated) => void;
};

type LabelResponse = { recognitionId: string | null; label: NormalizedLabel; model: string; latencyMs: number };
type Fields = { name: string; brand: string; kcal: string; protein: string; fat: string; carbs: string };

const STATES: { id: FoodState; label: string }[] = [
  { id: 'dry', label: 'сухой' },
  { id: 'as_is', label: 'как есть' },
  { id: 'cooked', label: 'готовый' },
  { id: 'raw', label: 'сырой' },
];
const PORTIONS: Record<FoodState, number[]> = { dry: [30, 40, 50, 80], as_is: [50, 100, 150, 200], cooked: [150, 200, 250, 300], raw: [100, 150, 200, 250] };
const DEFAULT_PORTION: Record<FoodState, number> = { dry: 40, as_is: 100, cooked: 200, raw: 150 };
// Small print needs more pixels than a plate photo.
const LABEL_MAX_SIDE = 2048;
const LABEL_JPEG_QUALITY = 0.88;
// Re-checked live from the fields, so the server's versions of these are not shown.
const LIVE_CODES = new Set(['mismatch', 'macro_sum']);

const parse = (s: string): number | null => {
  const n = Number(s.replace(',', '.').trim());
  return s.trim() !== '' && Number.isFinite(n) && n >= 0 ? n : null;
};

/** «Свой продукт по этикетке»: photo → numbers per 100 g → usual portion → personal food. */
export function LabelForm({ initialFile, initialName = '', barcode = null, onCreated }: Props) {
  const session = useSession();
  const [fields, setFields] = useState<Fields>({ name: initialName, brand: '', kcal: '', protein: '', fat: '', carbs: '' });
  const [state, setState] = useState<FoodState>('as_is');
  const [portion, setPortion] = useState('');
  const [servingG, setServingG] = useState<number | null>(null);
  const [fiber, setFiber] = useState<number | null>(null);
  const [notes, setNotes] = useState<string[]>([]);
  const [photoUrl, setPhotoUrl] = useState<string | null>(null);
  const [recognitionId, setRecognitionId] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const started = useRef(false);

  useEffect(() => {
    if (initialFile && !started.current) {
      started.current = true;
      void read(initialFile);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialFile]);
  useEffect(() => () => { if (photoUrl) URL.revokeObjectURL(photoUrl); }, [photoUrl]);

  async function read(file: File) {
    if (!session) return;
    setReading(true);
    setError(null);
    setNotes([]);
    try {
      const { blob, width, height } = await prepareImage(file, { maxSide: LABEL_MAX_SIDE, quality: LABEL_JPEG_QUALITY });
      setPhotoUrl(URL.createObjectURL(blob));
      const mediaId = await uploadMedia(session.user.id, 'photo', blob, 'jpg', { width, height });
      const { label, recognitionId: rid } = await api<LabelResponse>('/api/recognize/label', { body: { media_id: mediaId } });
      setFields((f) => ({
        name: label.name ?? f.name, brand: label.brand ?? f.brand,
        kcal: String(label.per100.kcal), protein: String(label.per100.protein), fat: String(label.per100.fat), carbs: String(label.per100.carbs),
      }));
      setState(label.state);
      setServingG(label.servingG);
      setFiber(label.per100.fiber);
      setPortion((p) => p || String(label.servingG ?? DEFAULT_PORTION[label.state]));
      setNotes(label.warnings.filter((w) => !LIVE_CODES.has(w.code)).map((w) => w.text));
      setRecognitionId(rid);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Не получилось прочитать этикетку — введи цифры вручную.');
    } finally {
      setReading(false);
    }
  }

  const kcal = parse(fields.kcal);
  const protein = parse(fields.protein) ?? 0;
  const fat = parse(fields.fat) ?? 0;
  const carbs = parse(fields.carbs) ?? 0;
  const grams = parse(portion) ?? DEFAULT_PORTION[state];
  const check = kcal != null ? checkLabelNumbers(kcal, protein, fat, carbs) : null;
  const valid = fields.name.trim().length > 0 && kcal != null && kcal <= 900 && !check?.macroSumTooHigh && grams > 0;
  const portionKcal = kcal != null ? (kcal * grams) / 100 : 0;

  async function save() {
    if (!valid || kcal == null) return;
    setSaving(true);
    setError(null);
    try {
      const { food } = await api<{ food: Food; created: boolean }>('/api/foods', {
        body: {
          name: fields.name.trim(), brand: fields.brand.trim() || null, state, kcal, protein, fat, carbs, fiber,
          portion_g: grams, barcode, recognition_id: recognitionId,
        },
      });
      onCreated({ food, grams, recognitionId });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  const set = (k: keyof Fields) => (e: React.ChangeEvent<HTMLInputElement>) => setFields((f) => ({ ...f, [k]: e.target.value }));
  const choices = Array.from(new Set([...(servingG ? [servingG] : []), ...PORTIONS[state]]));

  return (
    <div className="space-y-4 p-4">
      <div className="flex items-center gap-3">
        {photoUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={photoUrl} alt="Фото этикетки" width={64} height={64} className="h-16 w-16 shrink-0 rounded-xl border border-rule object-cover" />
        ) : (
          <span className="flex h-16 w-16 shrink-0 items-center justify-center rounded-xl border border-dashed border-rule-strong font-mono text-xl text-ink-3" aria-hidden>▤</span>
        )}
        <div className="min-w-0 flex-1">
          <p className="label">свой продукт · по этикетке</p>
          <button type="button" onClick={() => fileInput.current?.click()} disabled={reading}
            className="press mt-1 rounded-full border border-ink px-4 py-2 text-sm disabled:opacity-40">
            {reading ? <span className="blink">читаю этикетку…</span> : photoUrl ? '◉ переснять' : '◉ фото этикетки'}
          </button>
        </div>
      </div>
      <input ref={fileInput} type="file" accept="image/*" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void read(f); e.target.value = ''; }} />
      {reading && <p className="font-mono text-xs text-ink-3">Модель переписывает цифры с фото, обычно 10–30 секунд. Можно пока ввести вручную.</p>}
      {error && <p className="text-sm text-over" role="alert">{error}</p>}

      <input value={fields.name} onChange={set('name')} placeholder="Название, как на упаковке" aria-label="Название продукта"
        className="w-full rounded-xl border border-rule bg-card px-3 py-3 outline-none focus:border-ink" />

      <div>
        <p className="label">на 100 {state === 'cooked' ? 'г готового' : state === 'dry' ? 'г сухого' : 'г'}</p>
        <div className="mt-1 grid grid-cols-4 gap-2">
          {([['kcal', 'ккал'], ['protein', 'белки'], ['fat', 'жиры'], ['carbs', 'углев.']] as const).map(([k, label]) => (
            <label key={k} className="block">
              <span className="font-mono text-[11px] text-ink-3">{label}</span>
              <input inputMode="decimal" value={fields[k]} onChange={set(k)} aria-label={`${label} на 100 г`}
                className="tabular mt-1 w-full rounded-xl border border-rule bg-card px-2 py-2 text-right font-mono outline-none focus:border-ink" />
            </label>
          ))}
        </div>
      </div>

      <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Состояние продукта">
        {STATES.map((s) => (
          <button key={s.id} type="button" role="radio" aria-checked={state === s.id} onClick={() => setState(s.id)}
            className={`press rounded-full border px-3 py-1.5 text-xs ${state === s.id ? 'border-ink bg-ink text-linen' : 'border-rule'}`}>{s.label}</button>
        ))}
      </div>
      {state === 'dry' && <p className="text-xs text-ink-3">Цифры на сухой продукт: вес вводи сухой крупы, до варки.</p>}

      {(notes.length > 0 || check?.kcalMismatch || check?.macroSumTooHigh) && (
        <ul className="space-y-1 rounded-xl bg-card/70 px-3 py-2 text-xs text-warn">
          {check?.macroSumTooHigh && <li>Белков, жиров и углеводов вместе больше 100 г — проверь цифры.</li>}
          {check?.kcalMismatch && !check.macroSumTooHigh && <li>По БЖУ выходит ≈ {Math.round(check.kcalFromMacros)} ккал, а не {Math.round(kcal ?? 0)}. Сверь с упаковкой.</li>}
          {notes.map((n) => <li key={n}>{n}</li>)}
        </ul>
      )}

      <div>
        <p className="label">обычная порция</p>
        <div className="mt-1 flex flex-wrap items-center gap-2">
          {choices.map((g) => (
            <button key={g} type="button" onClick={() => setPortion(String(g))}
              className={`press rounded-full border px-3 py-1.5 font-mono text-xs ${grams === g ? 'border-ink bg-ink text-linen' : 'border-rule'}`}>
              {g === servingG ? `порция ${fmt(g)} г` : `${fmt(g)} г`}
            </button>
          ))}
          <label className="flex items-baseline gap-1 rounded-full border border-rule bg-card px-3 py-1">
            <input inputMode="decimal" value={portion} onChange={(e) => setPortion(e.target.value)} placeholder={String(DEFAULT_PORTION[state])}
              aria-label="Обычная порция, г" className="tabular w-12 bg-transparent text-right font-mono text-sm outline-none" />
            <span className="text-xs text-ink-3">г</span>
          </label>
        </div>
      </div>

      <button type="button" onClick={save} disabled={!valid || saving || reading} className="press w-full rounded-full bg-ink py-3.5 font-medium text-linen disabled:opacity-40">
        {saving ? 'Сохраняю…' : valid ? `Добавить · ${fmt(grams)} г · ${Math.round(portionKcal)} ккал` : 'Добавить'}
      </button>
      <p className="text-center text-xs text-ink-3">Модель только переписывает цифры — сверь их с упаковкой. Продукт сохранится в твою базу.</p>
    </div>
  );
}
