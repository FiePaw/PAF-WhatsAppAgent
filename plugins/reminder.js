// plugins/reminder.js
// Contoh plugin yang memanfaatkan cronService dan db.
// Fitur: owner bisa set reminder → bot kirim ke target pada waktu tertentu.
//
// Commands:
//   !remind <menit> <pesan>  → set reminder untuk owner sendiri setelah N menit
//   !reminders               → list semua reminder aktif
//   !remindclear             → hapus semua reminder owner

import db from '../services/db.js';
import cronService from '../services/cronService.js';
import config from '../config/config.js';
import logger from '../utils/logger.js';

// Referensi sock disimpan saat pertama kali digunakan (injected via ctx)
let _sock = null;

// Nama collection di JSON db
const COLLECTION = 'reminders';

// Cron job: cek reminder setiap menit
const CHECK_JOB = 'reminder:checkDue';

async function checkDueReminders() {
  const now = Date.now();
  const due = db.find(COLLECTION, {}).filter(
    (r) => !r.sent && r.dueAt <= now
  );

  for (const reminder of due) {
    if (!_sock) continue;
    try {
      await _sock.sendMessage(reminder.jid, { text: `⏰ *Reminder:* ${reminder.message}` });
      await db.update(COLLECTION, { _id: reminder._id }, { sent: true });
      logger.info({ jid: reminder.jid, message: reminder.message }, '⏰ Reminder terkirim');
    } catch (err) {
      logger.error({ err: err.message, _id: reminder._id }, '❌ Gagal kirim reminder');
    }
  }
}

export default {
  name: 'reminder',
  description: 'Set dan kelola reminder berbasis waktu',
  commands: ['remind', 'reminders', 'remindclear'],
  ownerOnly: true,

  // ── Cron job didaftarkan via pluginLoader ────────────────────────────────
  crons: [
    {
      name: CHECK_JOB,
      expr: '* * * * *', // setiap menit
      handler: checkDueReminders,
    },
  ],

  async handler({ sock, jid, sender, command, args, fullArgs, reply }) {
    // Inject sock reference untuk dipakai cron job
    _sock = sock;

    // ── !remind <menit> <pesan> ────────────────────────────────────────────
    if (command === 'remind') {
      const minutes = parseInt(args[0]);
      const message = args.slice(1).join(' ');

      if (!minutes || minutes < 1 || !message) {
        await reply('📌 Format: *!remind <menit> <pesan>*\nContoh: !remind 10 Cek server');
        return;
      }

      const dueAt = Date.now() + minutes * 60 * 1000;
      const reminder = await db.insert(COLLECTION, {
        jid,
        sender,
        message,
        dueAt,
        sent: false,
      });

      const dueTime = new Date(dueAt).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
      await reply(`✅ Reminder diset! Kamu akan diingatkan pukul *${dueTime}* (~${minutes} menit lagi).\nPesan: _${message}_`);
      return;
    }

    // ── !reminders ─────────────────────────────────────────────────────────
    if (command === 'reminders') {
      const active = db.find(COLLECTION, { jid, sent: false });
      if (!active.length) {
        await reply('📭 Tidak ada reminder aktif.');
        return;
      }
      const lines = active.map((r, i) => {
        const t = new Date(r.dueAt).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
        return `${i + 1}. [${t}] ${r.message}`;
      });
      await reply(`📋 *Reminder aktif (${active.length}):*\n${lines.join('\n')}`);
      return;
    }

    // ── !remindclear ────────────────────────────────────────────────────────
    if (command === 'remindclear') {
      const removed = await db.delete(COLLECTION, { jid, sent: false });
      await reply(`🗑️ ${removed} reminder dihapus.`);
    }
  },
};