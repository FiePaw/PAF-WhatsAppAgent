// plugins/scheduled/calendarReminder.js — polling pengingat MyCalendar tiap menit.
// Tujuan kirim: grup yang di-assign `!group channel <groupJid> calendar output`, fallback DM owner.
import * as cal from '../../services/calendarClient.js';
import { getGroupOutput } from '../../services/groupService.js';
import config from '../../config/config.js';
import logger from '../../utils/logger.js';

const PLUGIN_KEY = 'calendar';
let running = false; // satu siklus tidak boleh tumpang tindih

function targets() {
  const groups = getGroupOutput(PLUGIN_KEY) || [];
  if (groups.length) return groups;
  const owner = config.ownerLid || config.ownerJid;
  return owner ? [owner] : [];
}

/** Kirim ke semua target. Sukses bila minimal satu target menerima. */
async function send(text) {
  const sock = global._sock;
  if (!sock) throw new Error('bot offline (_sock null)');
  const list = targets();
  if (!list.length) throw new Error('tidak ada target kirim (grup channel/owner)');
  let ok = 0;
  for (const jid of list) {
    try { await sock.sendMessage(jid, { text }); ok += 1; } catch (err) {
      logger.warn({ jid, err: err.message }, '⚠️ calendarReminder: gagal kirim ke target');
    }
  }
  if (!ok) throw new Error('semua target gagal');
}

async function tick() {
  if (running) return;
  if (!global._sock) return; // bot offline: jangan ambil (lease) reminder yang tak bisa dikirim
  running = true;
  try {
    let due;
    try {
      due = await cal.getRemindersDue(20);
    } catch (err) {
      // 503 = PC rumah offline: lewati siklus tanpa berisik
      if (err.status !== 503) logger.warn({ err: err.message }, '⚠️ calendarReminder: gagal ambil reminders/due');
      return;
    }
    const acks = [];
    for (const item of due.items || []) {
      try { await send(item.text); acks.push({ id: item.id, ok: true }); } catch (err) {
        // Tidak di-ack: reminder tetap leased lalu kembali pending setelah lease habis.
        logger.warn({ id: item.id, err: err.message }, '⚠️ calendarReminder: kirim gagal, tidak di-ack');
      }
    }
    if (due.combined && due.combined.text) {
      try { await send(due.combined.text); for (const id of due.combined.ids) acks.push({ id, ok: true }); } catch (err) {
        logger.warn({ err: err.message }, '⚠️ calendarReminder: kirim ringkasan tertunda gagal, tidak di-ack');
      }
    }
    if (due.missed_summary) {
      try { await send(`⚠️ ${due.missed_summary}`); } catch { /* informasi saja */ }
    }
    if (acks.length) {
      try { await cal.ackReminders(acks); } catch (err) { logger.warn({ err: err.message }, '⚠️ calendarReminder: gagal ack'); }
    }
  } catch (err) {
    logger.error({ err: err.message }, '❌ calendarReminder: error tak terduga');
  } finally {
    running = false;
  }
}

export default {
  name: 'Calendar Reminder',
  description: 'Kirim pengingat MyCalendar (digest H-1, 30 menit sebelum, berita high impact)',
  crons: [
    {
      name: 'scheduled:calendarReminder',
      expr: '@every_1m',
      handler: tick,
      runOnStart: true,
    },
  ],
};
