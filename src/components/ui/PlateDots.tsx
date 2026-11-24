'use client';

// Signature element: the day's "plate" as a dot matrix (Stingray-style halftone).
// Dots fill clockwise with the share of the calorie corridor eaten; protein fills the
// inner ring. Purely decorative: the numbers next to it carry the information.

type Props = { kcalShare: number; proteinShare: number; size?: number };

export function PlateDots({ kcalShare, proteinShare, size = 132 }: Props) {
  const cols = 15;
  const c = (cols - 1) / 2;
  const cell = size / cols;
  const r = cell * 0.36;
  const dots: { x: number; y: number; fill: string; o: number }[] = [];
  for (let y = 0; y < cols; y++) {
    for (let x = 0; x < cols; x++) {
      const d = Math.hypot(x - c, y - c);
      if (d > c + 0.25) continue;
      const angle = ((Math.atan2(x - c, -(y - c)) + Math.PI * 2) % (Math.PI * 2)) / (Math.PI * 2);
      const outer = d > c * 0.55;
      const share = outer ? kcalShare : proteinShare;
      const on = share > 0 && angle <= Math.min(share, 1);
      const over = outer && kcalShare > 1 && angle <= kcalShare - 1;
      dots.push({
        x: x * cell + cell / 2,
        y: y * cell + cell / 2,
        fill: over ? 'var(--over)' : on ? (outer ? 'var(--kcal)' : 'var(--protein)') : 'var(--rule-strong)',
        o: on ? 1 : 0.55 + 0.3 * (1 - d / c),
      });
    }
  }
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden className="shrink-0">
      {dots.map((d, i) => <circle key={i} cx={d.x} cy={d.y} r={r} fill={d.fill} opacity={d.o} />)}
    </svg>
  );
}
