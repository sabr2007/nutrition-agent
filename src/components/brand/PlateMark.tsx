// The app mark: a dot-matrix plate, partly "filled" — the same visual language as the
// ASCII plate on the Today screen. Rendered with Satori (next/og), so plain divs only.
type Props = { size: number; padding?: number };

export function PlateMark({ size, padding = 0.1 }: Props) {
  const inner = size * (1 - padding * 2);
  const cols = 11;
  const cell = inner / cols;
  const dot = Math.max(2, cell * 0.52);
  const c = (cols - 1) / 2;
  const dots: { x: number; y: number; on: boolean; ring: boolean }[] = [];
  for (let y = 0; y < cols; y++) {
    for (let x = 0; x < cols; x++) {
      const d = Math.hypot(x - c, y - c);
      if (d > c + 0.2) continue;
      const ring = d > c - 1.1;
      const angle = (Math.atan2(y - c, x - c) + Math.PI * 2.5) % (Math.PI * 2);
      dots.push({ x, y, on: !ring && angle < Math.PI * 1.25, ring });
    }
  }
  return (
    <div style={{ width: size, height: size, display: 'flex', background: '#efede4', position: 'relative' }}>
      {dots.map((d, i) => (
        <div
          key={i}
          style={{
            position: 'absolute',
            left: size * padding + d.x * cell + (cell - dot) / 2,
            top: size * padding + d.y * cell + (cell - dot) / 2,
            width: dot,
            height: dot,
            borderRadius: dot,
            background: d.ring ? '#1d1a15' : d.on ? '#d9541a' : '#bdb6a4',
          }}
        />
      ))}
    </div>
  );
}
