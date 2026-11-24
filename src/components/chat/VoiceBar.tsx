'use client';

import { ArrowUpIcon, CloseIcon, StopIcon } from '@/components/ui/icons';

type Props = {
  levels: number[];
  transcribing: boolean;
  onCancel: () => void;
  onStop: () => void;
  onSend: () => void;
};

const MIN_BAR_PX = 2;
const MAX_BAR_PX = 22;

/**
 * Recording state of the composer, as in ChatGPT: cancel, a dotted live waveform, stop (→ text
 * into the field) and send (→ transcribe and send at once). While transcribing, stop becomes a spinner.
 */
export function VoiceBar({ levels, transcribing, onCancel, onStop, onSend }: Props) {
  return (
    <div className="flex h-[52px] items-center gap-2 px-1.5" role="group" aria-label={transcribing ? 'Расшифровываю голос' : 'Идёт запись голоса'}>
      <button type="button" onClick={onCancel} aria-label="Отменить запись" disabled={transcribing}
        className="press flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-linen text-ink disabled:opacity-40">
        <CloseIcon size={18} />
      </button>
      <div className="flex h-8 flex-1 items-center justify-between gap-[2px] overflow-hidden px-1" aria-hidden>
        {levels.map((l, i) => (
          <span key={i} className="w-[2.5px] shrink-0 rounded-full bg-ink/70 transition-[height] duration-75"
            style={{ height: `${Math.round(MIN_BAR_PX + l * (MAX_BAR_PX - MIN_BAR_PX))}px`, opacity: transcribing ? 0.35 : 1 }} />
        ))}
      </div>
      {transcribing ? (
        <span className="flex h-9 w-9 shrink-0 items-center justify-center" aria-label="Расшифровываю">
          <span className="h-[18px] w-[18px] animate-spin rounded-full border-2 border-ink-3 border-t-transparent" />
        </span>
      ) : (
        <button type="button" onClick={onStop} aria-label="Остановить и вставить текст"
          className="press flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-ink">
          <StopIcon size={14} />
        </button>
      )}
      <button type="button" onClick={onSend} aria-label="Отправить голосом" disabled={transcribing}
        className="press flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-ink text-linen disabled:opacity-40">
        <ArrowUpIcon size={18} />
      </button>
    </div>
  );
}
