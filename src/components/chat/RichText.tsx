import type { ReactNode } from 'react';

// Minimal markdown for agent replies: paragraphs, **bold**, bullet and numbered lists, headings.
// Text is rendered as React text nodes only (no HTML injection).

const BULLET = /^\s*(?:[-*•·])\s+/;
const NUMBERED = /^\s*(\d+)[.)]\s+/;
const HEADING = /^\s*#{1,4}\s+/;

function inline(line: string, key: string): ReactNode[] {
  return line.split(/(\*\*[^*]+\*\*)/g).filter(Boolean).map((part, i) => (
    part.startsWith('**') && part.endsWith('**') && part.length > 4
      ? <strong key={`${key}-${i}`} className="font-semibold">{part.slice(2, -2)}</strong>
      : <span key={`${key}-${i}`}>{part}</span>
  ));
}

type Block = { kind: 'p' | 'h' | 'ul' | 'ol'; lines: string[] };

function blocks(text: string): Block[] {
  const out: Block[] = [];
  for (const raw of text.replace(/\r/g, '').split('\n')) {
    const line = raw.trimEnd();
    const last = out[out.length - 1];
    if (!line.trim()) {
      out.push({ kind: 'p', lines: [] });
      continue;
    }
    if (HEADING.test(line)) out.push({ kind: 'h', lines: [line.replace(HEADING, '')] });
    else if (BULLET.test(line)) {
      if (last?.kind === 'ul') last.lines.push(line.replace(BULLET, ''));
      else out.push({ kind: 'ul', lines: [line.replace(BULLET, '')] });
    } else if (NUMBERED.test(line)) {
      if (last?.kind === 'ol') last.lines.push(line.replace(NUMBERED, ''));
      else out.push({ kind: 'ol', lines: [line.replace(NUMBERED, '')] });
    } else if (last?.kind === 'p' && last.lines.length) last.lines.push(line);
    else out.push({ kind: 'p', lines: [line] });
  }
  return out.filter((b) => b.lines.length);
}

export function RichText({ text }: { text: string }) {
  return (
    <div className="space-y-2.5">
      {blocks(text).map((b, i) => {
        const k = `b${i}`;
        if (b.kind === 'h') return <p key={k} className="font-semibold">{inline(b.lines[0], k)}</p>;
        if (b.kind === 'ul' || b.kind === 'ol') {
          const List = b.kind === 'ul' ? 'ul' : 'ol';
          return (
            <List key={k} className={`space-y-1 pl-5 ${b.kind === 'ul' ? 'list-disc' : 'list-decimal'} marker:text-ink-3`}>
              {b.lines.map((l, j) => <li key={`${k}-${j}`}>{inline(l, `${k}-${j}`)}</li>)}
            </List>
          );
        }
        return <p key={k}>{b.lines.map((l, j) => <span key={`${k}-${j}`} className="block">{inline(l, `${k}-${j}`)}</span>)}</p>;
      })}
    </div>
  );
}
