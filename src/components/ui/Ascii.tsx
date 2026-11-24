// ASCII data primitives. Every visual has a text equivalent for screen readers, and
// colour is never the only signal (glyphs + numbers carry the meaning).

type BarProps = {
  value: number;
  min: number;           // lower edge of the target corridor
  max: number | null;    // upper edge (null = open)
  scaleMax?: number;     // full width of the bar
  width?: number;        // characters
  color?: string;        // CSS colour for the filled part
  label: string;
};

/** [▓▓▓▓▓▓▓░░░┊░░┊░░] — filled part, target corridor marked with ┊. */
export function AsciiBar({ value, min, max, scaleMax, width = 24, color = 'var(--ink)', label }: BarProps) {
  const top = scaleMax ?? Math.max(value, (max ?? min) * 1.15, 1);
  const pos = (v: number) => Math.min(width, Math.max(0, Math.round((v / top) * width)));
  const filled = pos(value);
  const a = pos(min);
  const b = max != null ? pos(max) : -1;
  const cells = Array.from({ length: width }, (_, i) => {
    if (i === a || i === b) return { ch: '┊', on: i < filled, marker: true };
    return { ch: i < filled ? '█' : '░', on: i < filled, marker: false };
  });
  const over = max != null && value > max;
  return (
    <span className="ascii inline-block text-[13px] leading-none" role="img" aria-label={`${label}: ${Math.round(value)} из ${min}${max ? '–' + max : '+'}`}>
      <span className="text-ink-3">[</span>
      {cells.map((c, i) => (
        <span key={i} style={{ color: c.marker ? 'var(--ink-2)' : c.on ? (over && i >= b ? 'var(--over)' : color) : 'var(--rule-strong)' }}>{c.ch}</span>
      ))}
      <span className="text-ink-3">]</span>
    </span>
  );
}

/** ▮▮▮▯▯ confidence meter (0..1). */
export function Meter({ value, label = 'уверенность' }: { value: number | null | undefined; label?: string }) {
  if (value == null) return null;
  const n = Math.round(Math.min(1, Math.max(0, value)) * 5);
  const tone = value >= 0.75 ? 'var(--ok)' : value >= 0.5 ? 'var(--warn)' : 'var(--over)';
  return (
    <span className="ascii text-[11px]" role="img" aria-label={`${label} ${Math.round(value * 100)}%`} title={`${label} ${Math.round(value * 100)}%`}>
      <span style={{ color: tone }}>{'▮'.repeat(n)}</span>
      <span className="text-rule-strong">{'▯'.repeat(5 - n)}</span>
    </span>
  );
}

const BLOCKS = '▁▂▃▄▅▆▇█';

/** Text sparkline: ▁▂▃▅▇ — nulls shown as · */
export function Sparkline({ values, label, color = 'var(--ink)' }: { values: (number | null)[]; label: string; color?: string }) {
  const nums = values.filter((v): v is number => v != null);
  if (!nums.length) return <span className="ascii text-ink-3">· · ·</span>;
  const lo = Math.min(...nums);
  const hi = Math.max(...nums);
  const span = hi - lo || 1;
  const s = values.map((v) => (v == null ? '·' : BLOCKS[Math.round(((v - lo) / span) * (BLOCKS.length - 1))])).join('');
  return <span className="ascii text-base tracking-[0.08em]" style={{ color }} role="img" aria-label={`${label}: от ${lo} до ${hi}`}>{s}</span>;
}
