'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import useSWR from 'swr';
import { api, ApiError, fetcher, newClientId, postOrQueue, refreshToday } from '@/lib/client/api';
import type { TodayResponse, TemplateLite } from '@/lib/client/types';
import type { Draft, DraftItem } from '@/lib/client/draft';
import { slotByTime } from '@/lib/client/draft';
import { pickAudioMime, prepareImage, uploadMedia } from '@/lib/client/media';
import { fmt } from '@/lib/client/format';
import { localParts } from '@/lib/nutrition/day';
import { itemFromFood } from '@/lib/nutrition/calc';
import type { Food } from '@/lib/nutrition/types';
import { supabaseBrowser } from '@/lib/supabase/browser';
import { useSession } from '@/components/auth/AuthGate';
import { useToast } from '@/components/ui/Toast';
import { ConfirmView } from './ConfirmView';
import { FoodSearch } from './FoodSearch';
import { LabelForm, type LabelCreated } from './LabelForm';

type RecognizeResponse = {
  recognitionId: string | null; items: DraftItem[]; questions: Draft['questions']; confidence: number; agreement: number | null;
  usedLlm: boolean; models: string[]; transcript?: string;
};

const OFFSETS = [
  { label: 'сейчас', min: 0 },
  { label: '−30 мин', min: 30 },
  { label: '−1 ч', min: 60 },
  { label: '−2 ч', min: 120 },
];

export function LogView() {
  const router = useRouter();
  const params = useSearchParams();
  const editId = params.get('edit');
  const session = useSession();
  const toast = useToast();
  const { data } = useSWR<TodayResponse>('/api/today', fetcher);
  const tz = data?.summary.profile.timezone ?? 'Asia/Almaty';

  const [offset, setOffset] = useState(0);
  const [customTime, setCustomTime] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState<null | 'text' | 'photo' | 'voice' | 'save' | 'barcode'>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [slot, setSlot] = useState(() => slotByTime(new Date().getHours()));
  const [recording, setRecording] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [barcodeOpen, setBarcodeOpen] = useState(false);
  const [labelSheet, setLabelSheet] = useState<{ file: File; barcode: string | null } | null>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const recStart = useRef(0);
  const photoInput = useRef<HTMLInputElement>(null);
  const scaleInput = useRef<HTMLInputElement>(null);
  const photoMode = useRef<'plate' | 'scale'>('plate');
  const galleryInput = useRef<HTMLInputElement>(null);
  const labelInput = useRef<HTMLInputElement>(null);
  const pendingBarcode = useRef<string | null>(null);

  const eatenAt = (): Date => {
    if (customTime) {
      const [h, m] = customTime.split(':').map(Number);
      const now = new Date();
      const local = localParts(now, tz);
      let diff = (local.hour * 60 + local.minute) - (h * 60 + m);
      if (diff < 0) diff += 1440;
      return new Date(now.getTime() - diff * 60_000);
    }
    return new Date(Date.now() - offset * 60_000);
  };
  const timeLabel = customTime ?? (offset ? `${OFFSETS.find((o) => o.min === offset)?.label}` : 'сейчас');
  const localTime = () => localParts(eatenAt(), tz).hhmm;

  // Edit mode: load an existing meal into the confirmation screen.
  useEffect(() => {
    if (!editId) return;
    (async () => {
      const { data: m } = await supabaseBrowser().from('meals').select('id, slot, title, eaten_at, template_id, meal_items(food_id, name, grams, per100, kcal, protein_g, fat_g, carbs_g, confidence, source, sort_order)').eq('id', editId).single();
      if (!m) return;
      const items = ((m.meal_items ?? []) as unknown as (DraftItem & { sort_order: number })[]).sort((a, b) => a.sort_order - b.sort_order).map((i, idx) => ({ ...i, key: `e${idx}`, grams: Number(i.grams), kcal: Number(i.kcal), protein_g: Number(i.protein_g), fat_g: Number(i.fat_g), carbs_g: Number(i.carbs_g) }));
      setSlot((m.slot as string) ?? slot);
      setCustomTime(localParts(new Date(m.eaten_at as string), tz).hhmm);
      setDraft({ source: 'edit', recognitionId: null, items, questions: [], confidence: null, agreement: null, supersedesId: m.id as string, templateId: m.template_id as string | null, title: m.title as string | null, shownAt: Date.now() });
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editId]);

  function fromRecognition(r: RecognizeResponse, source: Draft['source'], photoUrl?: string): Draft {
    return { source, recognitionId: r.recognitionId, items: r.items, questions: r.questions ?? [], confidence: r.confidence, agreement: r.agreement, transcript: r.transcript ?? null, photoUrl, shownAt: Date.now(), usedLlm: r.usedLlm, models: r.models };
  }

  async function submitText() {
    if (!text.trim()) return;
    setBusy('text');
    try {
      const r = await api<RecognizeResponse>('/api/recognize/text', { body: { text, local_time: localTime() } });
      if (!r.items.length) { toast({ text: 'Не понял, что записать. Попробуй иначе или выбери шаблон.' }); return; }
      setDraft(fromRecognition(r, 'text'));
    } catch (e) {
      toast({ text: (e as Error).message, tone: 'error' });
    } finally {
      setBusy(null);
    }
  }

  async function onPhoto(file: File | undefined) {
    if (!file || !session) return;
    setBusy('photo');
    try {
      const { blob, width, height } = await prepareImage(file);
      const previewUrl = URL.createObjectURL(blob);
      const mediaId = await uploadMedia(session.user.id, 'photo', blob, 'jpg', { width, height });
      const r = await api<RecognizeResponse>('/api/recognize/photo', { body: { media_ids: [mediaId], mode: photoMode.current, note: text || undefined, local_time: localTime() } });
      setDraft(fromRecognition(r, photoMode.current === 'scale' ? 'scale' : 'photo', previewUrl));
    } catch (e) {
      toast({ text: (e as Error).message, tone: 'error' });
    } finally {
      setBusy(null);
    }
  }

  /** Opens the photo picker for a nutrition label (library or camera; no `capture` on purpose). */
  function pickLabel(barcode: string | null = null) {
    pendingBarcode.current = barcode;
    labelInput.current?.click();
  }

  function fromLabel(r: LabelCreated) {
    setLabelSheet(null);
    setDraft({ source: 'label', recognitionId: r.recognitionId, items: [{ ...itemFromFood(r.food, r.grams, { source: 'user' }), key: 'l0' }], questions: [], confidence: null, agreement: null, shownAt: Date.now() });
  }

  async function toggleRecording() {
    if (recording) {
      recorder.current?.stop();
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const { mime, ext } = pickAudioMime();
      const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      chunks.current = [];
      rec.ondataavailable = (e) => e.data.size && chunks.current.push(e.data);
      rec.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        setRecording(false);
        const blob = new Blob(chunks.current, { type: rec.mimeType || mime || 'audio/mp4' });
        if (blob.size < 1500 || !session) { toast({ text: 'Слишком коротко — скажи ещё раз' }); return; }
        setBusy('voice');
        try {
          const mediaId = await uploadMedia(session.user.id, 'audio', blob, ext, { duration_ms: Date.now() - recStart.current });
          const r = await api<RecognizeResponse>('/api/recognize/voice', { body: { media_id: mediaId, local_time: localTime() } });
          setDraft(fromRecognition(r, 'voice'));
        } catch (e) {
          toast({ text: e instanceof ApiError ? e.message : 'Не получилось распознать голос', tone: 'error' });
        } finally {
          setBusy(null);
        }
      };
      recorder.current = rec;
      recStart.current = Date.now();
      rec.start();
      setRecording(true);
    } catch {
      toast({ text: 'Нет доступа к микрофону', tone: 'error' });
    }
  }

  async function logTemplate(t: TemplateLite) {
    const clientId = newClientId('tpl');
    const res = await postOrQueue<{ meal: { id: string; kcal: number } }>('/api/meals/template', { template_id: t.id, client_id: clientId, eaten_at: eatenAt().toISOString() });
    if (res.queued) toast({ text: `Нет сети — «${t.name}» запишется позже` });
    else toast({ text: `${t.name} · ${Math.round(res.data!.meal.kcal)} ккал`, action: { label: 'отменить', onClick: () => void api(`/api/meals/${res.data!.meal.id}`, { method: 'DELETE' }).then(refreshToday) } });
    void refreshToday();
    router.push('/');
  }

  function editTemplate(t: TemplateLite) {
    (async () => {
      const ids = t.items.map((i) => i.food_id);
      const { data: foods } = await supabaseBrowser().from('foods').select('*').in('id', ids);
      const byId = new Map(((foods ?? []) as Food[]).map((f) => [f.id, f]));
      const items: DraftItem[] = t.items.map((i, idx) => ({ ...itemFromFood(byId.get(i.food_id)!, i.grams, { source: 'template' }), key: `t${idx}` }));
      setSlot(t.slot);
      setDraft({ source: 'template', recognitionId: null, items, questions: [], confidence: 1, agreement: null, templateId: t.id, title: t.name, shownAt: Date.now() });
    })();
  }

  async function save(d: Draft, opts: { isLabeled: boolean }) {
    setBusy('save');
    const method = d.source === 'edit' ? 'manual' : d.source === 'template' ? 'template' : d.source;
    const body = {
      supersedes_id: d.supersedesId ?? null,
      eaten_at: eatenAt().toISOString(),
      slot, title: d.title ?? d.items.map((i) => i.name.split(/[,(]/)[0].trim()).slice(0, 3).join(', '),
      input_method: method, template_id: d.templateId ?? null, recognition_id: d.recognitionId,
      confidence: d.confidence, is_labeled: opts.isLabeled, time_to_confirm_ms: Date.now() - d.shownAt,
      client_id: newClientId('meal'),
      items: d.items.map((i) => ({ food_id: i.food_id, name: i.name, grams: i.grams, state: i.state ?? null, per100: i.per100, confidence: i.confidence ?? null, source: i.source, model_grams: i.model_grams ?? null, model_label: i.model_label ?? null, edited: i.edited ?? false })),
    };
    try {
      const res = await postOrQueue<{ meal: { kcal: number; protein_g: number } }>('/api/meals', body);
      toast({ text: res.queued ? 'Нет сети — сохраню, когда появится' : `Записал · ${Math.round(res.data!.meal.kcal)} ккал · б ${Math.round(res.data!.meal.protein_g)}` });
      void refreshToday();
      router.push('/');
    } catch (e) {
      toast({ text: (e as Error).message, tone: 'error' });
    } finally {
      setBusy(null);
    }
  }

  const templates = (data?.templates ?? []).filter((t) => !t.training_day_only || data?.summary.trainingDay);
  const recent = (data?.summary.meals ?? []).slice(-4).reverse();

  return (
    <main className="relative mx-auto max-w-md px-4 pt-[calc(10px+var(--safe-top))]">
      <header className="flex items-center justify-between">
        <button onClick={() => (draft && !editId ? setDraft(null) : router.back())} className="press -ml-2 rounded-full px-3 py-2 font-mono text-ink-2" aria-label="Назад">← {draft ? 'назад' : 'закрыть'}</button>
        <h1 className="font-display text-xl">{editId ? 'Правка' : 'Записать'}</h1>
        <span className="w-16" />
      </header>

      <div className="no-scrollbar mt-3 flex gap-2 overflow-x-auto pb-1" role="radiogroup" aria-label="Когда ел">
        {OFFSETS.map((o) => (
          <button key={o.min} role="radio" aria-checked={!customTime && offset === o.min} onClick={() => { setOffset(o.min); setCustomTime(null); }}
            className={`press shrink-0 rounded-full border px-3 py-1.5 font-mono text-xs ${!customTime && offset === o.min ? 'border-ink bg-ink text-linen' : 'border-rule'}`}>{o.label}</button>
        ))}
        <label className={`press flex shrink-0 items-center gap-1 rounded-full border px-3 py-1 font-mono text-xs ${customTime ? 'border-ink bg-ink text-linen' : 'border-rule'}`}>
          <span>время</span>
          <input type="time" value={customTime ?? ''} onChange={(e) => setCustomTime(e.target.value || null)} className="bg-transparent outline-none" aria-label="Точное время" />
        </label>
      </div>

      {draft ? (
        <div className="mt-4">
          <ConfirmView draft={draft} slot={slot} onSlot={setSlot} timeLabel={timeLabel} saving={busy === 'save'} onSave={save} onCancel={() => (editId ? router.back() : setDraft(null))} />
        </div>
      ) : (
        <>
          <form onSubmit={(e) => { e.preventDefault(); void submitText(); }} className="surface mt-4 flex items-end gap-2 p-2">
            <textarea value={text} onChange={(e) => setText(e.target.value)} rows={2} placeholder="грудка 250, гречка 50 сухая…"
              className="min-h-[52px] flex-1 resize-none bg-transparent px-2 py-2 outline-none placeholder:text-ink-3" aria-label="Что съел"
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void submitText(); } }} />
            <button type="submit" disabled={!text.trim() || busy !== null} className="press mb-1 rounded-full bg-ink px-4 py-2.5 text-sm text-linen disabled:opacity-40">
              {busy === 'text' ? <span className="blink">думаю</span> : 'Разобрать'}
            </button>
          </form>

          <div className="mt-3 grid grid-cols-3 gap-2">
            <ActionTile glyph="◉" label="фото" busy={busy === 'photo' && photoMode.current === 'plate'} onClick={() => { photoMode.current = 'plate'; photoInput.current?.click(); }} />
            <ActionTile glyph="⚖" label="на весах" busy={busy === 'photo' && photoMode.current === 'scale'} onClick={() => { photoMode.current = 'scale'; scaleInput.current?.click(); }} />
            <ActionTile glyph={recording ? '■' : '●'} label={recording ? 'стоп' : 'голос'} active={recording} busy={busy === 'voice'} onClick={toggleRecording} />
            <ActionTile glyph="▥" label="штрихкод" busy={busy === 'barcode'} onClick={() => setBarcodeOpen(true)} />
            <ActionTile glyph="▤" label="этикетка" onClick={() => pickLabel()} />
            <ActionTile glyph="◫" label="из галереи" onClick={() => { photoMode.current = 'plate'; galleryInput.current?.click(); }} />
          </div>
          <input ref={photoInput} type="file" accept="image/*" capture="environment" hidden onChange={(e) => { void onPhoto(e.target.files?.[0]); e.target.value = ''; }} />
          <input ref={scaleInput} type="file" accept="image/*" capture="environment" hidden onChange={(e) => { void onPhoto(e.target.files?.[0]); e.target.value = ''; }} />
          <input ref={galleryInput} type="file" accept="image/*" hidden aria-label="Фото еды из галереи" onChange={(e) => { void onPhoto(e.target.files?.[0]); e.target.value = ''; }} />
          <input ref={labelInput} type="file" accept="image/*" hidden aria-label="Фото этикетки" onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) setLabelSheet({ file, barcode: pendingBarcode.current });
            pendingBarcode.current = null;
            e.target.value = '';
          }} />
          {busy === 'photo' && <p className="mt-2 text-center font-mono text-xs text-ink-3 blink">смотрю на тарелку… обычно 20–40 секунд</p>}
          {recording && <p className="mt-2 text-center font-mono text-xs text-over blink">идёт запись — скажи, что и сколько съел</p>}

          <section className="mt-6">
            <div className="flex items-baseline justify-between px-1">
              <h2 className="font-display text-xl">Шаблоны</h2>
              <button onClick={() => setSearchOpen(true)} className="press font-mono text-xs text-ink-2 underline decoration-dotted underline-offset-4">поиск продукта</button>
            </div>
            <ul className="mt-2 grid grid-cols-2 gap-2">
              {templates.map((t) => (
                <li key={t.id} className="surface relative">
                  <button onClick={() => logTemplate(t)} className="press flex h-full w-full flex-col items-start gap-1 p-3 pr-9 text-left">
                    <span className="flex w-full items-center justify-between">
                      <span className="font-mono text-base" aria-hidden>{t.glyph ?? '+'}</span>
                      {t.default_time && <span className="font-mono text-[11px] text-ink-3">{t.default_time}</span>}
                    </span>
                    <span className="text-sm font-medium leading-snug">{t.name}</span>
                    <span className="tabular font-mono text-[11px] text-ink-3">{t.kcal} ккал · б {fmt(t.protein_g)}</span>
                  </button>
                  <button aria-label={`Изменить перед записью: ${t.name}`} onClick={() => editTemplate(t)} className="press absolute right-1 top-1 rounded-full px-2 py-1 font-mono text-xs text-ink-3">✎</button>
                </li>
              ))}
            </ul>
          </section>

          {recent.length > 0 && (
            <section className="mt-6 pb-10">
              <h2 className="px-1 font-display text-xl">Повторить</h2>
              <ul className="mt-2 space-y-2">
                {recent.map((m) => (
                  <li key={m.id}>
                    <button onClick={async () => { await api(`/api/meals/${m.id}/repeat`, { body: { eaten_at: eatenAt().toISOString() } }); toast({ text: `Повторил: ${m.title}` }); void refreshToday(); router.push('/'); }}
                      className="press surface flex w-full items-center justify-between px-4 py-3 text-left">
                      <span className="truncate text-sm">{m.title}</span>
                      <span className="font-mono text-xs text-ink-3">{Math.round(m.kcal)} ккал ↻</span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}
          <p className="pb-10 text-center text-xs text-ink-3"><Link href="/coach" className="underline decoration-dotted">или просто напиши коучу</Link></p>
        </>
      )}

      {searchOpen && (
        <FoodSearch onClose={() => setSearchOpen(false)} onPick={(f) => {
          setSearchOpen(false);
          setDraft({ source: 'manual', recognitionId: null, items: [{ ...itemFromFood(f, Number(f.default_portion_g ?? 100), { source: 'user' }), key: 'm0' }], questions: [], confidence: null, agreement: null, shownAt: Date.now() });
        }} />
      )}
      {barcodeOpen && <BarcodeSheet onClose={() => setBarcodeOpen(false)} onLabel={(code) => { setBarcodeOpen(false); pickLabel(code); }} onFood={(f) => { setBarcodeOpen(false); setDraft({ source: 'barcode', recognitionId: null, items: [{ ...itemFromFood(f, Number(f.default_portion_g ?? 100), { source: 'barcode' }), key: 'b0' }], questions: [], confidence: null, agreement: null, shownAt: Date.now() }); }} />}
      {labelSheet && (
        <div className="fixed inset-0 z-40 flex flex-col bg-ink/30 backdrop-blur-[2px]" role="dialog" aria-modal="true" aria-label="Продукт по этикетке">
          <button className="flex-1" aria-label="Закрыть" onClick={() => setLabelSheet(null)} />
          <div className="sheet-enter max-h-[88dvh] overflow-y-auto rounded-t-[var(--radius-lg)] bg-linen pb-[var(--safe-bottom)] shadow-[var(--shadow-float)]">
            <LabelForm initialFile={labelSheet.file} barcode={labelSheet.barcode} onCreated={fromLabel} />
          </div>
        </div>
      )}
    </main>
  );
}

function ActionTile({ glyph, label, onClick, busy, active }: { glyph: string; label: string; onClick: () => void; busy?: boolean; active?: boolean }) {
  return (
    <button onClick={onClick} disabled={busy} className={`press surface flex flex-col items-center gap-1 py-3 ${active ? 'border-over' : ''}`}>
      <span className={`font-mono text-xl ${active ? 'text-over' : ''}`} aria-hidden>{busy ? '…' : glyph}</span>
      <span className="text-xs text-ink-2">{label}</span>
    </button>
  );
}

function BarcodeSheet({ onClose, onFood, onLabel }: { onClose: () => void; onFood: (f: Food) => void; onLabel: (code: string) => void }) {
  const [code, setCode] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notFound, setNotFound] = useState(false);
  const shot = useRef<HTMLInputElement>(null);
  async function fromPhoto(file: File | undefined) {
    if (!file) return;
    setBusy(true);
    setMsg('Читаю штрихкод…');
    try {
      const { decodeBarcodeFromFile } = await import('@/lib/client/barcode');
      const value = await decodeBarcodeFromFile(file);
      if (!value) { setMsg('Не разглядел штрихкод — сфоткай ближе и ровнее или введи цифры.'); return; }
      setCode(value);
      await lookup(value);
    } catch {
      setMsg('Не получилось прочитать фото. Введи цифры вручную.');
    } finally {
      setBusy(false);
    }
  }
  async function lookup(value = code) {
    setBusy(true);
    setMsg(null);
    setNotFound(false);
    try {
      const r = await api<{ food: Food | null; message?: string }>(`/api/barcode/${encodeURIComponent(value.trim())}`);
      if (r.food) onFood(r.food);
      else { setMsg(r.message ?? 'Не нашёл в Open Food Facts.'); setNotFound(true); }
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="fixed inset-0 z-40 flex flex-col bg-ink/30" role="dialog" aria-modal="true" aria-label="Штрихкод">
      <button className="flex-1" aria-label="Закрыть" onClick={onClose} />
      <div className="sheet-enter rounded-t-[var(--radius-lg)] bg-linen p-4 pb-[calc(16px+var(--safe-bottom))]">
        <p className="label">штрихкод · цифры под полосками</p>
        <div className="mt-2 flex gap-2">
          <input autoFocus inputMode="numeric" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} placeholder="4870001234567" className="flex-1 rounded-full border border-rule bg-card px-4 py-3 font-mono" aria-label="Штрихкод" />
          <button onClick={() => lookup()} disabled={code.length < 8 || busy} className="press rounded-full bg-ink px-5 text-linen disabled:opacity-40">{busy ? '…' : 'Найти'}</button>
        </div>
        <button onClick={() => shot.current?.click()} disabled={busy} className="press mt-3 w-full rounded-full border border-ink py-3 text-sm">◉ Сфоткать штрихкод</button>
        <input ref={shot} type="file" accept="image/*" capture="environment" hidden onChange={(e) => { void fromPhoto(e.target.files?.[0]); e.target.value = ''; }} />
        {msg && <p className="mt-3 text-sm text-ink-2">{msg}</p>}
        {notFound && <button onClick={() => onLabel(code)} className="press mt-3 w-full rounded-full bg-ink py-3 text-sm text-linen">▤ Сфоткать этикетку — сохраню с этим штрихкодом</button>}
        <p className="mt-3 text-xs text-ink-3">Ищу в Open Food Facts (в Казахстане ~1000 товаров, половина с КБЖУ). Найденное сохраняется в твою базу.</p>
      </div>
    </div>
  );
}
