// plugins/triggered/calendar.js — intent bahasa natural untuk jadwal (tambah / tanya agenda).
// Detail tanggal diekstrak di handler lewat panggilan AI terpisah yang diberi waktu sekarang (WIB),
// karena intent session hidup lama dan tidak tahu "hari ini". Konfirmasi memakai !ya / !tidak
// (plugins/calendar.js) karena balasan "ya" biasa tidak dijamin terdeteksi sebagai intent ini.
import { askAI } from '../../services/aiService.js';
import { sessionStore } from '../../services/sessionStore.js';
import * as cal from '../../services/calendarClient.js';
import {
  addDays, dateLabel, formatAgenda, hm, isValidDate, isValidTime, isoFromWib, nowLabel, summarizeWarnings, todayStr,
} from '../../services/calendarFormat.js';
import { setPending } from '../../services/calendarPending.js';
import logger from '../../utils/logger.js';

const EXTRACT_JID = 'triggered:calendarExtract';
const SYSTEM_PROMPT = 'Kamu adalah pengekstrak data jadwal. Balas HANYA dengan satu objek JSON valid tanpa teks lain dan tanpa markdown.';

async function extract(userText) {
  const prompt =
    `Sekarang: ${nowLabel()} (zona Asia/Jakarta).\n` +
    `Pesan pengguna: """${userText}"""\n\n` +
    'Ekstrak menjadi JSON dengan bentuk persis:\n' +
    '{"action":"create|query|update|delete|other","title":"judul atau null","date":"YYYY-MM-DD atau null",' +
    '"time":"HH:MM 24 jam atau null","duration_min":angka atau null,"location":"teks atau null",' +
    '"query_from":"YYYY-MM-DD atau null","query_to":"YYYY-MM-DD atau null"}\n' +
    'Aturan: waktu dalam WIB; selesaikan tanggal relatif ("besok", "Jumat depan") memakai waktu sekarang di atas; ' +
    '"create" = menambah acara baru; "query" = bertanya agenda/jadwal/kuliah (isi query_from dan query_to); ' +
    'time null bila jam tidak disebut; jangan mengarang nilai yang tidak disebut pengguna.';
  try {
    const raw = await askAI({ jid: EXTRACT_JID, userText: prompt, systemPrompt: SYSTEM_PROMPT, thinkMode: 'fast' });
    const s = String(raw ?? '');
    const a = s.indexOf('{'), b = s.lastIndexOf('}');
    if (a < 0 || b <= a) throw new Error('jawaban AI bukan JSON');
    return JSON.parse(s.slice(a, b + 1));
  } finally {
    try { sessionStore.delete(EXTRACT_JID); } catch { /* abaikan */ }
  }
}

function friendly(err) {
  if (err && err.status === 503) return '🔌 PC rumah (database MyCalendar) sedang offline. Coba lagi nanti.';
  return `⚠️ ${err && err.message ? err.message : 'Terjadi kesalahan'}`;
}

async function doQuery(p, reply) {
  const today = todayStr();
  let from = isValidDate(p.query_from) ? p.query_from : today;
  let to = isValidDate(p.query_to) ? p.query_to : from;
  if (to < from) [from, to] = [to, from];
  if (to > addDays(from, 30)) to = addDays(from, 30);
  const occs = await cal.getAgenda(from, to, true);
  await reply(formatAgenda(occs, from, to));
}

async function doCreate(p, sender, reply) {
  const title = typeof p.title === 'string' ? p.title.trim() : '';
  if (!title || !isValidDate(p.date)) {
    await reply('Saya butuh judul dan tanggal yang jelas. Contoh: "tambah rapat dosen Jumat jam 10".');
    return;
  }
  const timed = isValidTime(p.time);
  const payload = { title, category: 'meeting', location: p.location || '', recurrence: null };
  let when;
  if (timed) {
    const dur = Number.isFinite(Number(p.duration_min)) && Number(p.duration_min) > 0 ? Math.min(Number(p.duration_min), 1440) : 60;
    const start = isoFromWib(p.date, p.time);
    const end = new Date(Date.parse(start) + dur * 60000).toISOString().replace('.000Z', 'Z');
    Object.assign(payload, { all_day: false, start, end });
    when = `${dateLabel(p.date, true)} · ${hm(start)}–${hm(end)} WIB`;
  } else {
    Object.assign(payload, { all_day: true, start_date: p.date, end_date: p.date });
    when = `${dateLabel(p.date, true)} · seharian`;
  }
  let warn = '';
  if (timed) {
    try { warn = summarizeWarnings((await cal.checkConflicts('event', payload)).warnings); } catch (err) {
      if (err.status === 503) { await reply(friendly(err)); return; }
      /* cek bentrok gagal: tetap lanjut minta konfirmasi */
    }
  }
  setPending(sender, { kind: 'create', payload });
  await reply(`📝 Tambah jadwal:\n🗓️ ${title}\n📅 ${when}${p.location ? `\n📍 ${p.location}` : ''}${warn ? `\n${warn}` : ''}\n\nSimpan? Balas *!ya* atau *!tidak* (berlaku 5 menit).`);
}

export default {
  intent: 'calendar',
  intentDefinition: '"calendar" - owner membahas jadwal pribadinya: menambah acara/rapat/janji dengan tanggal atau hari tertentu, atau menanyakan agenda/jadwal/kuliah pada hari tertentu (contoh: "tambah rapat dosen Jumat jam 10", "besok ada kuliah apa?", "agenda minggu ini"). Ekstrak: request (string, isi permintaan owner apa adanya). Bukan untuk pengingat berbasis menit ("ingatkan 10 menit lagi" itu urusan !remind) dan bukan untuk mengirim pesan ke orang lain.',
  parameters: {
    type: 'object',
    properties: {
      request: { type: 'string', description: 'Isi permintaan owner tentang jadwal, ditulis apa adanya.' },
    },
    required: ['request'],
  },
  groupContextPrompt: 'Kamu adalah asisten jadwal pribadi owner. Kamu membantu mencatat acara, rapat, dan kuliah serta menjawab pertanyaan tentang agenda. Jawab ringkas dalam Bahasa Indonesia seperti chat biasa.',

  name: 'Calendar',
  description: 'Tambah/tanya jadwal MyCalendar lewat bahasa natural',
  ownerOnly: true,

  handler: async ({ params, text, sender, reply }) => {
    const request = (params && params.request) || text;
    try {
      const p = await extract(request);
      if (p.action === 'query') return await doQuery(p, reply);
      if (p.action === 'create') return await doCreate(p, sender, reply);
      if (p.action === 'update' || p.action === 'delete') {
        return await reply('Mengubah/menghapus jadwal lewat kalimat belum didukung. Gunakan *!agenda hapus <id>* (id tampil di !jadwal) atau aplikasi web.');
      }
      return await reply('Maaf, saya belum paham permintaan jadwal itu. Coba: !jadwal, !kuliah, atau "tambah rapat Jumat jam 10".');
    } catch (err) {
      logger.error({ intent: 'calendar', err: err.message }, 'Error di triggered plugin calendar');
      return reply(friendly(err));
    }
  },
};
