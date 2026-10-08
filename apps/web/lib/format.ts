const rtf = new Intl.RelativeTimeFormat('tr', { numeric: 'auto' });
const dtf = new Intl.DateTimeFormat('tr-TR', { dateStyle: 'medium', timeStyle: 'short' });
const df = new Intl.DateTimeFormat('tr-TR', { day: 'numeric', month: 'long', year: 'numeric' });
const tf = new Intl.DateTimeFormat('tr-TR', { hour: '2-digit', minute: '2-digit' });

type DateLike = string | number | Date | null | undefined;
const toDate = (d: DateLike) => (d === null || d === undefined ? null : d instanceof Date ? d : new Date(d));

export function ago(d: DateLike): string {
  const date = toDate(d);
  if (!date) return '—';
  const s = Math.round((date.getTime() - Date.now()) / 1000);
  const abs = Math.abs(s);
  if (abs < 45) return s <= 0 ? 'az önce' : 'birazdan';
  if (abs < 3600) return rtf.format(Math.round(s / 60), 'minute');
  if (abs < 86400) return rtf.format(Math.round(s / 3600), 'hour');
  if (abs < 86400 * 30) return rtf.format(Math.round(s / 86400), 'day');
  return df.format(date);
}

export const dateTime = (d: DateLike) => (toDate(d) ? dtf.format(toDate(d)!) : '—');
export const date = (d: DateLike) => (toDate(d) ? df.format(toDate(d)!) : '—');
export const time = (d: DateLike) => (toDate(d) ? tf.format(toDate(d)!) : '—');

export function dayLabel(d: DateLike): string {
  const date = toDate(d);
  if (!date) return '';
  const today = new Date();
  const y = new Date(today);
  y.setDate(today.getDate() - 1);
  if (date.toDateString() === today.toDateString()) return 'Bugün';
  if (date.toDateString() === y.toDateString()) return 'Dün';
  return df.format(date);
}

export function bytes(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—';
  if (n < 1024) return `${n} B`;
  const u = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${u[i]}`;
}

export function duration(ms: number | null | undefined): string {
  if (!ms && ms !== 0) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} sn`;
  return `${Math.floor(s / 60)} dk ${s % 60} sn`;
}

export function until(d: DateLike): string {
  const date = toDate(d);
  if (!date) return '—';
  const ms = date.getTime() - Date.now();
  if (ms <= 0) return 'süresi doldu';
  const h = Math.floor(ms / 3600_000);
  if (h >= 48) return `${Math.floor(h / 24)} gün kaldı`;
  if (h >= 1) return `${h} saat kaldı`;
  return `${Math.max(1, Math.floor(ms / 60_000))} dk kaldı`;
}

export const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .map((p) => p[0])
    .slice(0, 2)
    .join('')
    .toLocaleUpperCase('tr-TR');

export const shortSha = (s: string | null | undefined) => (s ? s.slice(0, 7) : '—');
