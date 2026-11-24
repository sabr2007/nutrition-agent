'use client';

import { useEffect, useRef, useState } from 'react';
import { api } from '@/lib/client/api';
import { uploadMedia } from '@/lib/client/media';
import { useToast } from '@/components/ui/Toast';
import { ArrowUpIcon, CloseIcon, GaugeIcon, MicIcon, PlusIcon } from '@/components/ui/icons';
import { MAX_PHOTOS, useAttachments, type Attachment } from './useAttachments';
import { useVoiceRecorder } from './useVoiceRecorder';
import { PlusMenu, SKILLS, type Skill } from './PlusMenu';
import { VoiceBar } from './VoiceBar';

export type OutgoingMessage = { text: string; attachments: { mediaId: string; previewUrl: string }[]; skill?: string };

type Props = {
  userId: string | undefined;
  busy: boolean;
  deep: boolean;
  onToggleDeep: () => void;
  onSend: (m: OutgoingMessage) => void;
  showSuggestions: boolean;
};

const MAX_TEXTAREA_PX = 168;
const SUGGESTIONS = SKILLS.slice(0, 4);

/** The ChatGPT-style composer: attachments above the field, "+" menu, microphone and send. */
export function Composer({ userId, busy, deep, onToggleDeep, onSend, showSuggestions }: Props) {
  const toast = useToast();
  const [text, setText] = useState('');
  const [menuOpen, setMenuOpen] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const field = useRef<HTMLTextAreaElement>(null);
  const cameraInput = useRef<HTMLInputElement>(null);
  const photosInput = useRef<HTMLInputElement>(null);
  const attachments = useAttachments(userId);
  // The recorder calls this at its length cap; it always points at the latest finishVoice.
  const onLimit = useRef<() => void>(() => undefined);
  const voice = useVoiceRecorder(() => onLimit.current());

  const fit = () => {
    const el = field.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, MAX_TEXTAREA_PX)}px`;
  };

  const hasContent = text.trim().length > 0 || attachments.items.length > 0;
  const canSend = hasContent && !busy && !attachments.uploading && !attachments.failed;

  function submit(override?: string) {
    const body = (override ?? text).trim();
    if ((!body && !attachments.ready.length) || busy || attachments.uploading || attachments.failed) return;
    onSend({ text: body, attachments: attachments.ready.map((a) => ({ mediaId: a.mediaId, previewUrl: a.previewUrl })) });
    setText('');
    attachments.clear();
    requestAnimationFrame(fit);
  }

  async function finishVoice(sendNow: boolean) {
    const clip = await voice.stop();
    if (!clip) {
      toast({ text: 'Слишком коротко — скажи ещё раз' });
      return;
    }
    if (!userId) return;
    setTranscribing(true);
    try {
      const mediaId = await uploadMedia(userId, 'audio', clip.blob, clip.ext, { duration_ms: clip.durationMs });
      const { text: spoken } = await api<{ text: string }>('/api/transcribe', { body: { media_id: mediaId } });
      if (!spoken.trim()) {
        toast({ text: 'Не расслышал — попробуй ещё раз' });
        return;
      }
      const combined = [text.trim(), spoken.trim()].filter(Boolean).join(' ');
      if (sendNow) submit(combined);
      else {
        setText(combined);
        requestAnimationFrame(() => { fit(); field.current?.focus(); });
      }
    } catch (e) {
      toast({ text: (e as Error).message, tone: 'error' });
    } finally {
      setTranscribing(false);
    }
  }

  useEffect(() => {
    onLimit.current = () => { void finishVoice(false); };
  });

  async function startVoice() {
    try {
      await voice.start();
    } catch {
      toast({ text: 'Нет доступа к микрофону — разреши его в настройках iPhone', tone: 'error' });
    }
  }

  function addFiles(files: FileList | null) {
    if (!files?.length) return;
    const skipped = attachments.add(files);
    if (skipped) toast({ text: `Можно приложить до ${MAX_PHOTOS} фото` });
  }

  function runSkill(s: Skill) {
    if (busy) return;
    onSend({ text: s.text, attachments: [], skill: s.skill });
  }

  return (
    <div className="relative">
      {showSuggestions && !hasContent && (
        <div className="no-scrollbar -mx-3 mb-2 flex gap-2 overflow-x-auto px-3">
          {SUGGESTIONS.map((s) => (
            <button key={s.label} type="button" onClick={() => runSkill(s)} disabled={busy}
              className="press shrink-0 rounded-full border border-rule/70 bg-card/90 px-3.5 py-2 text-sm text-ink-2 backdrop-blur disabled:opacity-50">{s.label}</button>
          ))}
        </div>
      )}

      <div className="relative">
        {menuOpen && (
          <PlusMenu deep={deep} onToggleDeep={onToggleDeep} onClose={() => setMenuOpen(false)}
            onCamera={() => cameraInput.current?.click()} onPhotos={() => photosInput.current?.click()} onSkill={runSkill} />
        )}
        <div className="rounded-[28px] border border-rule/70 bg-card shadow-[var(--shadow-composer)]">
          {voice.recording || transcribing ? (
            <VoiceBar levels={voice.levels} transcribing={transcribing} onCancel={voice.cancel}
              onStop={() => void finishVoice(false)} onSend={() => void finishVoice(true)} />
          ) : (
            <form onSubmit={(e) => { e.preventDefault(); submit(); }}>
              {attachments.items.length > 0 && <AttachmentStrip items={attachments.items} onRemove={attachments.remove} />}
              <textarea ref={field} value={text} rows={1} placeholder="Спроси Рядом" aria-label="Сообщение"
                onChange={(e) => { setText(e.target.value); fit(); }}
                onKeyDown={(e) => {
                  const coarse = window.matchMedia('(pointer: coarse)').matches;
                  if (e.key === 'Enter' && !e.shiftKey && !coarse && !e.nativeEvent.isComposing) { e.preventDefault(); submit(); }
                }}
                className="block max-h-[168px] w-full resize-none bg-transparent px-4 pt-3.5 text-[16px] leading-6 outline-none placeholder:text-ink-3 focus-visible:outline-none" />
              <div className="flex items-center gap-1 px-2 pb-2 pt-1.5">
                <button type="button" onClick={() => setMenuOpen((v) => !v)} aria-label="Добавить" aria-haspopup="menu" aria-expanded={menuOpen}
                  className={`press flex h-10 w-10 items-center justify-center rounded-full text-ink transition-transform ${menuOpen ? 'rotate-45 bg-linen' : ''}`}>
                  <PlusIcon size={24} />
                </button>
                {deep && (
                  <button type="button" onClick={onToggleDeep} aria-label="Выключить «Думать дольше»"
                    className="press fade-in flex items-center gap-1.5 rounded-full bg-chip py-1.5 pl-2.5 pr-2 text-[13px] text-ink">
                    <GaugeIcon size={16} /> Думать дольше <CloseIcon size={14} className="text-ink-3" />
                  </button>
                )}
                <span className="flex-1" />
                <button type="button" onClick={() => void startVoice()} aria-label="Сказать голосом" disabled={busy}
                  className="press flex h-10 w-10 items-center justify-center rounded-full text-ink disabled:opacity-40">
                  <MicIcon size={22} />
                </button>
                {hasContent && (
                  <button type="submit" disabled={!canSend} aria-label="Отправить"
                    className="press fade-in flex h-9 w-9 items-center justify-center rounded-full bg-ink text-linen disabled:opacity-35">
                    {attachments.uploading ? <span className="h-4 w-4 animate-spin rounded-full border-2 border-linen/70 border-t-transparent" /> : <ArrowUpIcon size={19} />}
                  </button>
                )}
              </div>
            </form>
          )}
        </div>
      </div>

      <input ref={cameraInput} type="file" accept="image/*" capture="environment" hidden aria-label="Снять фото"
        onChange={(e) => { addFiles(e.target.files); e.target.value = ''; }} />
      <input ref={photosInput} type="file" accept="image/*" multiple hidden aria-label="Выбрать фото"
        onChange={(e) => { addFiles(e.target.files); e.target.value = ''; }} />
    </div>
  );
}

function AttachmentStrip({ items, onRemove }: { items: Attachment[]; onRemove: (key: string) => void }) {
  return (
    <ul className="no-scrollbar flex gap-2 overflow-x-auto px-3 pt-3" aria-label="Вложения">
      {items.map((a) => (
        <li key={a.key} className="thumb-in relative h-[92px] w-[92px] shrink-0 overflow-hidden rounded-[16px] bg-linen">
          {/* eslint-disable-next-line @next/next/no-img-element -- local blob preview */}
          <img src={a.previewUrl} alt="Фото к сообщению" className={`h-full w-full object-cover ${a.status === 'error' ? 'opacity-40' : ''}`} />
          {a.status === 'uploading' && (
            <span className="absolute inset-0 flex items-center justify-center bg-ink/15">
              <span className="h-5 w-5 animate-spin rounded-full border-2 border-white border-t-transparent" />
            </span>
          )}
          {a.status === 'error' && <span className="absolute inset-x-0 bottom-1 text-center font-mono text-[10px] text-over">не загрузилось</span>}
          <button type="button" onClick={() => onRemove(a.key)} aria-label="Убрать фото"
            className="press absolute right-1.5 top-1.5 flex h-6 w-6 items-center justify-center rounded-full bg-ink/80 text-white backdrop-blur">
            <CloseIcon size={13} strokeWidth={2.4} />
          </button>
        </li>
      ))}
    </ul>
  );
}
