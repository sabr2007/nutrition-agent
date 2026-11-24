const months = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const weekdays = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'];

export function dayTitle(day: string): { weekday: string; date: string } {
  const [y, m, d] = day.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return { weekday: weekdays[dt.getUTCDay()], date: `${d} ${months[m - 1]}` };
}

export function hhmm(iso: string, tz = 'Asia/Almaty'): string {
  return new Intl.DateTimeFormat('ru-RU', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso));
}

export const fmt = (n: number | null | undefined, digits = 0) => (n == null ? '—' : n.toLocaleString('ru-RU', { maximumFractionDigits: digits, minimumFractionDigits: 0 }));

export function plural(n: number, one: string, few: string, many: string): string {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  if (b === 1) return one;
  return many;
}
