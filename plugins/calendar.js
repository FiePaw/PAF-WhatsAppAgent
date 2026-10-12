// plugins/calendar.js — command plugin MyCalendar: !jadwal, !agenda, !kuliah, !berita, !ya, !tidak
import * as cal from '../services/calendarClient.js';
import {
  addDays, formatAgenda, newsLine, shortId, summarizeWarnings, todayStr,
} from '../services/calendarFormat.js';
import { setPending, takePending } from '../services/calendarPending.js';
import logger from '../utils/logger.js';

function friendly(err) {
  if (err && err.status === 503) return '🔌 PC rumah (database MyCalendar) sedang offline. Coba lagi nanti.';
  return `⚠️ ${err && err.message ? err.message : 'Terjadi kesalahan'}`;
}

function rangeFor(arg) {
  const a = (arg || '').trim().toLowerCase();
  const today = todayStr();
  if (a.includes('besok')) { const d = addDays(today, 1); return [d, d]; }
  if (a.includes('lusa')) { const d = addDays(today, 2); return [d, d]; }
  if (a.includes('minggu') || a.includes('pekan')) return [today, addDays(today, 6)];
  return [today, today];
}

async function showAgenda(reply, arg) {
  const [from, to] = rangeFor(arg);
  const occs = await cal.getAgenda(from, to, true);
  await reply(formatAgenda(occs, from, to));
}

async function showCourses(reply) {
  const today = todayStr();
  const to = addDays(today, 1);
  const occs = (await cal.getAgenda(today, to, false)).filter((o) => o.source_type === 'course');
  await reply(occs.length ? formatAgenda(occs, today, to) : 'Tidak ada kuliah hari ini/besok.');
}

async function showNews(reply, arg) {
  if ((arg || '').toLowerCase().includes('refresh')) {
    try {
      await cal.refreshNews(true);
      await reply('🔄 Pengambilan berita dimulai di latar belakang. Cek lagi beberapa menit lagi dengan !berita.');
    } catch (err) {
      if (err.status === 409) { await reply('⏳ Pengambilan berita sedang berjalan. Cek lagi sebentar lagi.'); return; }
      throw err;
    }
    return;
  }
  const today = todayStr();
  const items = await cal.getNews(today, addDays(today, 7));
  if (!items.length) { await reply('Tidak ada rilis USD high impact dalam 7 hari ke depan. (!berita refresh untuk mengambil data baru)'); return; }
  await reply(items.sort((a, b) => a.release_utc.localeCompare(b.release_utc)).map(newsLine).join('\n'));
}

async function askDelete(reply, sender, idArg) {
  const prefix = String(idArg || '').replace(/^#/, '').trim().toLowerCase();
  if (prefix.length < 4) { await reply('❓ Penggunaan: !agenda hapus <id> (id tampil sebagai #xxxxxxxx di daftar !jadwal, minimal 4 karakter).'); return; }
  const events = await cal.listEvents();
  const hits = events.filter((e) => e.id.toLowerCase().startsWith(prefix));
  if (!hits.length) { await reply(`Tidak ada jadwal dengan id #${prefix}. Hanya jadwal penting (🗓️) yang bisa dihapus lewat chat.`); return; }
  if (hits.length > 1) { await reply(`Id #${prefix} cocok dengan beberapa jadwal:\n${hits.map((e) => `• #${shortId(e.id)} ${e.title}`).join('\n')}\nTulis id lebih panjang.`); return; }
  const ev = hits[0];
  setPending(sender, { kind: 'delete', id: ev.id, title: ev.title });
  await reply(`🗑️ Hapus "${ev.title}"${ev.recurrence ? ' (seluruh seri berulang)' : ''}?\nBalas *!ya* untuk menghapus atau *!tidak* untuk batal (berlaku 5 menit).`);
}

async function confirmYes(reply, sender) {
  const p = takePending(sender);
  if (!p) { await reply('Tidak ada yang menunggu konfirmasi (atau sudah kedaluwarsa).'); return; }
  if (p.kind === 'create') {
    const saved = await cal.createEvent(p.payload);
    const w = summarizeWarnings(saved.warnings);
    await reply(`✅ Tersimpan: ${saved.title}  #${shortId(saved.id)}${w ? `\n${w}` : ''}`);
  } else if (p.kind === 'delete') {
    await cal.deleteEvent(p.id);
    await reply(`🗑️ Dihapus: ${p.title}`);
  }
}

export default {
  name: 'calendar',
  description: 'MyCalendar: jadwal, kuliah, berita ekonomi, hapus agenda',
  commands: ['jadwal', 'agenda', 'kuliah', 'berita', 'ya', 'tidak'],
  ownerOnly: true,

  handler: async ({ command, args, fullArgs, sender, reply }) => {
    try {
      switch (command) {
        case 'jadwal':
          await showAgenda(reply, fullArgs);
          break;
        case 'agenda':
          if ((args[0] || '').toLowerCase() === 'hapus') await askDelete(reply, sender, args[1]);
          else await showAgenda(reply, fullArgs);
          break;
        case 'kuliah':
          await showCourses(reply);
          break;
        case 'berita':
          await showNews(reply, fullArgs);
          break;
        case 'ya':
          await confirmYes(reply, sender);
          break;
        case 'tidak':
          await reply(takePending(sender) ? 'Dibatalkan.' : 'Tidak ada yang menunggu konfirmasi.');
          break;
        default:
          break;
      }
    } catch (err) {
      logger.error({ command, err: err.message }, 'Error di plugin calendar');
      await reply(friendly(err));
    }
  },
};
