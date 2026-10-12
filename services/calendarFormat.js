// services/calendarFormat.js — util waktu WIB (UTC+7, tanpa DST) dan format teks WhatsApp. ESM.
// Tidak bergantung pada zona waktu mesin tempat bot berjalan.

const WIB_MS = 7 * 3600 * 1000;
const DOW = ['Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu', 'Minggu'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
export const pad = (n) => String(n).padStart(2, '0');

export function wibParts(t) {
  const d = new Date((typeof t === 'number' ? t : new Date(t).getTime()) + WIB_MS);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes(), dow: ((d.getUTCDay() + 6) % 7) + 1 };
}
export const dateStr = (p) => `${p.y}-${pad(p.m)}-${pad(p.d)}`;
export const dateOf = (t) => dateStr(wibParts(t));
export const todayStr = (now = Date.now()) => dateOf(now);
export const hm = (t) => { const p = wibParts(t); return `${pad(p.h)}:${pad(p.mi)}`; };

export function addDays(s, n) {
  const [y, m, d] = s.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}
export function dowOf(s) { const [y, m, d] = s.split('-').map(Number); return ((new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7) + 1; }

/** Tanggal WIB 'YYYY-MM-DD' + 'HH:MM' -> ISO UTC (tanpa milidetik) */
export function isoFromWib(date, hhmm = '00:00') {
  const [y, m, d] = date.split('-').map(Number);
  const [h, mi] = hhmm.split(':').map(Number);
  return new Date(Date.UTC(y, m - 1, d, h - 7, mi)).toISOString().replace('.000Z', 'Z');
}
export const isValidDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && dateOf(isoFromWib(s, '12:00')) === s;
export const isValidTime = (s) => typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);

export function dateLabel(s, withYear = false) {
  const [y, m, d] = s.split('-').map(Number);
  return `${DOW[dowOf(s) - 1]}, ${d} ${MON[m - 1]}${withYear ? ` ${y}` : ''}`;
}
export function nowLabel(now = Date.now()) {
  const p = wibParts(now);
  return `${dateLabel(dateStr(p), true)} ${pad(p.h)}:${pad(p.mi)} WIB`;
}
export const shortId = (id) => String(id || '').slice(0, 8);

const ICON = { course: '📚', event: '🗓️', news: '🇺🇸' };

export function occLine(o) {
  let time;
  if (o.all_day) time = 'Seharian';
  else if (o.source_type === 'news') time = `${hm(o.start)} WIB`;
  else time = o.end ? `${hm(o.start)}–${hm(o.end)}` : hm(o.start);
  const loc = o.location && o.source_type !== 'news' ? ` · ${o.location}` : '';
  const label = o.label && o.source_type !== 'news' ? ` (${o.label})` : '';
  const extra = o.source_type === 'news' && o.meta && o.meta.forecast ? ` · fcst ${o.meta.forecast}` : '';
  const id = o.source_type === 'event' ? `  #${shortId(o.source_id)}` : '';
  const conflict = o.conflict_with && o.conflict_with.length ? '  ⚠️ bentrok' : '';
  return `${time}  ${ICON[o.source_type] || '•'} ${o.title}${label}${loc}${extra}${id}${conflict}`;
}

/** Agenda satu hari -> satu blok; beberapa hari -> dikelompokkan per tanggal. */
export function formatAgenda(occs, from, to) {
  if (!occs.length) return `Tidak ada agenda ${from === to ? `untuk ${dateLabel(from)}` : `pada ${dateLabel(from)} s.d. ${dateLabel(to)}`}.`;
  const byDate = new Map();
  for (const o of [...occs].sort((a, b) => a.start.localeCompare(b.start))) {
    const d = dateOf(o.start);
    if (!byDate.has(d)) byDate.set(d, []);
    byDate.get(d).push(o);
  }
  return [...byDate.entries()].map(([d, list]) => `📅 *${dateLabel(d)}*\n${list.map(occLine).join('\n')}`).join('\n\n');
}

export function newsLine(n) {
  const d = dateOf(n.release_utc);
  const tag = n.verified ? '' : ' _(data AI, cek ulang)_';
  const fc = n.forecast ? ` · fcst ${n.forecast}` : '';
  return `🇺🇸 ${dateLabel(d)} ${hm(n.release_utc)} WIB — *${n.indicator}* (tier ${n.tier})${fc}${tag}`;
}

export function summarizeWarnings(w) {
  if (!w || !w.count) return '';
  const s = w.samples && w.samples[0];
  return `⚠️ Bentrok di ${w.count} tanggal${s ? ` (contoh ${dateLabel(s.date)}: ${s.a} vs ${s.b})` : ''}.`;
}
