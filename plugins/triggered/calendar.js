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
    '{"action":"create|query|cancel_course|reschedule_course|exam_course|update|delete|other",' +
    '"title":"judul acara/ujian atau null","course_name":"nama mata kuliah jika terkait perkuliahan atau null",' +
    '"date":"YYYY-MM-DD atau null","time":"HH:MM 24 jam atau null","duration_min":angka atau null,"location":"teks atau null",' +
    '"new_date":"YYYY-MM-DD atau null","new_time":"HH:MM 24 jam atau null","new_room":"ruang pengganti atau null",' +
    '"note":"alasan/catatan atau null","query_from":"YYYY-MM-DD atau null","query_to":"YYYY-MM-DD atau null"}\n' +
    'Aturan: waktu dalam WIB; selesaikan tanggal relatif ("besok", "Jumat depan") memakai waktu sekarang di atas; ' +
    '"create" = menambah acara/agenda non-kuliah baru; "query" = bertanya agenda/jadwal/kuliah (isi query_from dan query_to); ' +
    '"cancel_course" = kuliah libur/ditiadakan di tanggal tertentu; "reschedule_course" = kuliah dipindah/ganti hari/jam; ' +
    '"exam_course" = ujian kuliah (UTS/UAS) di tanggal tertentu; ' +
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

async function doCourseException(p, sender, reply) {
  const keyword = (p.course_name || p.title || '').trim().toLowerCase();
  const date = isValidDate(p.date) ? p.date : todayStr();
  if (!keyword) {
    await reply('⚠️ Sebutkan nama mata kuliah yang dimaksud. Contoh: "kuliah kalkulus senin depan libur".');
    return;
  }
  let courses = [];
  try {
    courses = await cal.listCourses();
  } catch (err) {
    await reply(friendly(err));
    return;
  }
  const hits = (courses || []).filter((c) =>
    (c.name && c.name.toLowerCase().includes(keyword)) || (c.code && c.code.toLowerCase().includes(keyword))
  );
  if (!hits.length) {
    const listNames = (courses || []).map((c) => `• ${c.name}`).join('\n');
    await reply(`❌ Mata kuliah "*${keyword}*" tidak ditemukan di MyCalendar.\n\nMata kuliah terdaftar:\n${listNames || '(kosong)'}`);
    return;
  }
  const course = hits[0];

  let desc = '';
  let payload = {};

  if (p.action === 'reschedule_course') {
    const newDate = isValidDate(p.new_date) ? p.new_date : date;
    const newStart = isValidTime(p.new_time) ? p.new_time : (p.time || course.start_time);
    payload = {
      type: 'reschedule',
      new_date: newDate,
      new_start: newStart,
      new_room: p.new_room || p.location || course.room || '',
      note: p.note || 'Kuliah pengganti',
    };
    desc = `🔄 *Pindah Jadwal Kuliah*: ${course.name}\n📅 Tanggal asli: ${dateLabel(date)}\n➡️ Jadwal baru: ${dateLabel(newDate)} jam ${newStart} WIB${payload.new_room ? ` (${payload.new_room})` : ''}\n📝 Catatan: ${payload.note}`;
  } else if (p.action === 'exam_course') {
    payload = {
      type: 'exam',
      label: p.title || `Ujian ${course.name}`,
      new_date: date,
      new_start: isValidTime(p.time) ? p.time : course.start_time,
      new_room: p.location || course.room || '',
      note: p.note || 'Ujian',
    };
    desc = `📝 *Jadwal Ujian*: ${course.name}\n🏷️ ${payload.label}\n📅 Tanggal: ${dateLabel(date)} jam ${payload.new_start} WIB\n📍 Ruang: ${payload.new_room || '-'}`;
  } else {
    // cancel_course
    payload = {
      type: 'cancel',
      note: p.note || 'Dosen berhalangan / libur',
    };
    desc = `🚫 *Tandai Kuliah Libur / Batal*:\n📚 ${course.name}\n📅 Tanggal: ${dateLabel(date)}\n📝 Alasan: ${payload.note}`;
  }

  setPending(sender, {
    kind: 'course_exception',
    courseId: course.id,
    date,
    payload,
    run: async (r) => {
      await cal.setCourseException(course.id, date, payload);
      await r(`✅ Pengecualian kuliah berhasil disimpan:\n${desc}`);
    },
  });

  await reply(`${desc}\n\nSimpan pengecualian ini? Balas *!ya* atau *!tidak* (berlaku 5 menit).`);
}

export default {
  intent: 'calendar',
  intentDefinition: '"calendar" - owner membahas jadwal pribadinya: menambah acara/rapat/janji dengan tanggal tertentu, menanyakan agenda/jadwal/kuliah, atau menandai pengecualian kuliah seperti kuliah libur/batal, kuliah pengganti (reschedule), atau ujian (UTS/UAS) (contoh: "tambah rapat dosen Jumat jam 10", "besok ada kuliah apa?", "kuliah kalkulus senin depan libur", "uts basis data rabu jam 8"). Ekstrak: request (string, isi permintaan owner apa adanya).',
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
      if (p.action === 'cancel_course' || p.action === 'reschedule_course' || p.action === 'exam_course') {
        return await doCourseException(p, sender, reply);
      }
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
