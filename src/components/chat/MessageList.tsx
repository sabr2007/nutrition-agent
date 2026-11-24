'use client';

import { useEffect, useLayoutEffect, useMemo, useRef, type ReactNode } from 'react';
import type { ChatMessage, ChatPart } from '@/lib/chat/protocol';
import { RetryIcon } from '@/components/ui/icons';
import { AssistantExtras } from './AssistantExtras';
import { RichText } from './RichText';
import { localPreview, useSignedUrls } from './useMediaUrls';
import type { PendingTurn } from './useChatStream';

type Props = {
  messages: ChatMessage[];
  turn: PendingTurn | null;
  empty: ReactNode;
  header?: ReactNode;
  onChoice: (text: string) => void;
  onMemory: (messageId: string | null, id: string, ok: boolean) => void;
  onConfirm: (messageId: string | null, actionId: string, decision: 'confirm' | 'cancel') => void;
  onRetry: () => void;
  onDismiss: () => void;
};

/** Pixels from the bottom within which new content keeps the list pinned to the end. */
const STICK_PX = 120;

type ImagePart = Extract<ChatPart, { type: 'image' }>;
const imagesOf = (m: ChatMessage): ImagePart[] => (m.parts ?? []).filter((p): p is ImagePart => p.type === 'image');

export function MessageList({ messages, turn, empty, header, onChoice, onMemory, onConfirm, onRetry, onDismiss }: Props) {
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const lastIndex = messages.length - 1;

  const paths = useMemo(() => {
    const all = [...messages, ...(turn ? [turn.user] : [])].flatMap(imagesOf).filter((p) => p.path && !localPreview(p.media_id)).map((p) => p.path);
    return [...new Set(all)];
  }, [messages, turn]);
  const signed = useSignedUrls(paths);
  const src = (p: ImagePart) => localPreview(p.media_id) ?? signed[p.path];

  // First paint: start at the end of the conversation.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);

  useEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }, [messages.length, turn?.text, turn?.tool, turn?.status]);

  return (
    <div ref={scroller} onScroll={(e) => {
      const el = e.currentTarget;
      stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_PX;
    }} className="relative flex-1 overflow-y-auto overscroll-contain">
      <div className="mx-auto flex min-h-full max-w-md flex-col justify-end gap-6 px-4 pb-4 pt-3">
        {header}
        {!messages.length && !turn && empty}
        {messages.map((m, i) => {
          if (m.role === 'user') return <UserMessage key={m.id ?? `u${i}`} m={m} src={src} />;
          if (m.kind === 'event') return <p key={m.id ?? `e${i}`} className="text-center font-mono text-xs text-ink-3">{m.text}</p>;
          return (
            <article key={m.id ?? `a${i}`} className="fade-in text-[16px] leading-[1.55] text-ink">
              {m.kind === 'proactive' && <p className="label mb-1.5">сам написал</p>}
              <RichText text={m.text} />
              <AssistantExtras meta={m.meta ?? {}} isLast={i === lastIndex && !turn}
                onChoice={onChoice} onMemory={(id, ok) => onMemory(m.id, id, ok)} onConfirm={(aid, d) => onConfirm(m.id, aid, d)} />
            </article>
          );
        })}
        {turn && (
          <>
            <UserMessage m={turn.user} src={src} failed={turn.status === 'failed' ? turn.error ?? 'Не отправлено' : null} onRetry={onRetry} onDismiss={onDismiss} />
            {turn.status === 'streaming' && <StreamingReply text={turn.text} tool={turn.tool} deep={turn.payload.deep} />}
          </>
        )}
      </div>
    </div>
  );
}

function UserMessage({ m, src, failed, onRetry, onDismiss }: {
  m: ChatMessage; src: (p: ImagePart) => string | undefined; failed?: string | null; onRetry?: () => void; onDismiss?: () => void;
}) {
  const images = imagesOf(m);
  return (
    <div className="fade-in flex flex-col items-end gap-1.5">
      {images.length > 0 && (
        <div className={`grid max-w-[78%] gap-1.5 ${images.length > 1 ? 'grid-cols-2' : ''}`}>
          {images.map((p) => {
            const url = src(p);
            return url
              // eslint-disable-next-line @next/next/no-img-element -- signed URL from the private bucket
              ? <img key={p.media_id} src={url} alt="Фото" className={`${images.length > 1 ? 'aspect-square w-32' : 'max-h-72 w-56'} rounded-[18px] object-cover`} />
              : <span key={p.media_id} className={`${images.length > 1 ? 'aspect-square w-32' : 'h-56 w-56'} block animate-pulse rounded-[18px] bg-linen-deep`} />;
          })}
        </div>
      )}
      {m.text && <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-[22px] bg-bubble px-4 py-2.5 text-[16px] leading-snug">{m.text}</div>}
      {failed && (
        <div className="flex max-w-[85%] flex-col items-end gap-1.5 text-right">
          <p className="text-[13px] leading-snug text-over">{failed}</p>
          <div className="flex gap-2">
            <button type="button" onClick={onDismiss} className="press rounded-full px-3 py-1.5 text-xs text-ink-3">Убрать</button>
            <button type="button" onClick={onRetry} className="press flex items-center gap-1.5 rounded-full border border-ink/70 px-3 py-1.5 text-xs">
              <RetryIcon size={14} /> Повторить
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function StreamingReply({ text, tool, deep }: { text: string; tool: string | null; deep: boolean }) {
  if (text) {
    return <article className="text-[16px] leading-[1.55] text-ink" aria-live="polite"><RichText text={text} /></article>;
  }
  return (
    <div className="flex items-center gap-2.5" aria-live="polite">
      <span className="pulse-dot h-3.5 w-3.5 rounded-full bg-ink" aria-hidden />
      <span className="shimmer text-[15px]">{tool ? `${tool}…` : deep ? 'Думаю дольше…' : 'Думаю…'}</span>
    </div>
  );
}
