// services/followUpService.js
// Fitur 7 · Follow-up Engine
//
// Setiap sesi selesai, Qwen membaca history dan mengekstrak "event" —
// sesuatu yang user rencanakan, janjikan, atau niatkan yang memiliki waktu.
// Contoh: "besok aku presentasi", "minggu depan ke Bandung", "mau daftar gym".
//
// Event disimpan ke collection "followUpEvents". proactiveService cek setiap
// siklus — jika ada event yang sudah melewati waktu follow-up, bot akan
// mengirim pesan follow-up natural ke user tersebut.
//
// Struktur dokumen event:
// {
//   _id:         string,
//   jid:         string,
//   event:       string,    // deskripsi event ("presentasi di kampus")
//   context:     string,    // konteks asli dari percakapan
//   followUpAt:  ISO string,// kapan bot harus follow-up
//   done:        boolean,   // sudah di-follow-up atau belum
//   createdAt:   ISO string,
// }

import db from './db.js';
import { askAI } from './aiService.js';
import logger from '../utils/logger.js';

const COLLECTION = 'followUpEvents';

// ─── DB helpers ───────────────────────────────────────────────────────────────

/**
 * Ambil semua event yang sudah waktunya di-follow-up dan belum done.
 * @returns {object[]}
 */
export function getDueFollowUps() {
  const now = new Date().toISOString();
  return db.find(COLLECTION, {}).filter(
    (e) => !e.done && e.followUpAt <= now
  );
}

/**
 * Tandai event sebagai sudah di-follow-up.
 * @param {string} eventId - _id dari dokumen event
 */
export async function markFollowUpDone(eventId) {
  await db.update(COLLECTION, { _id: eventId }, { done: true });
}

/**
 * Ambil semua event aktif (belum done) untuk satu JID.
 * Digunakan untuk diinjeksi ke prompt proactiveService.
 *
 * @param {string} jid
 * @returns {object[]}
 */
export function getPendingFollowUps(jid) {
  return db.find(COLLECTION, { jid }).filter((e) => !e.done);
}

/**
 * Format pending follow-ups untuk diinjeksi ke prompt.
 * @param {string} jid
 * @returns {string}
 */
export function formatFollowUpsForPrompt(jid) {
  const pending = getPendingFollowUps(jid);
  if (!pending.length) return '';

  const lines = ['=== FOLLOW-UP YANG DIJADWALKAN ==='];
  for (const e of pending) {
    const followUpTime = new Date(e.followUpAt).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
    lines.push(`• "${e.event}" → follow-up dijadwalkan: ${followUpTime}`);
    if (e.context) lines.push(`  Konteks: ${e.context}`);
  }
  return lines.join('\n');
}

// ─── Core: ekstrak event dari history ────────────────────────────────────────

/**
 * Minta Qwen mengekstrak event/niat dari percakapan dan jadwalkan follow-up.
 * Dipanggil fire-and-forget setelah sesi chat selesai.
 *
 * @param {string} jid
 * @param {object[]} history
 */
export async function extractFollowUpEvents(jid, history) {
  if (!history?.length) return;

  // Ambil hanya pesan user (bukan bot) untuk efisiensi
  const userMessages = history
    .filter((e) => e.role === 'user')
    .slice(-20)
    .map((e) => {
      const time = new Date(e.timestamp).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
      return `[${time}] ${e.text}`;
    })
    .join('\n');

  const now = new Date().toISOString();
  const nowLocale = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });

  const prompt = `Kamu adalah sistem deteksi event dari percakapan WhatsApp. Baca pesan-pesan berikut dan temukan event, rencana, atau niat user yang memiliki dimensi waktu — sesuatu yang akan terjadi dan perlu di-follow-up.

Waktu sekarang: ${nowLocale}

=== PESAN USER ===
${userMessages}

=== TUGAS ===
Temukan semua event/rencana/niat yang disebutkan user. Untuk setiap event, tentukan kapan follow-up paling tepat (setelah event berlalu).

Contoh event yang valid:
- "besok aku presentasi" → follow-up keesokan hari setelah jam presentasi
- "minggu depan ke Jakarta" → follow-up saat tiba di Jakarta
- "mau daftar gym bulan ini" → follow-up seminggu kemudian
- "lagi galau soal pacar" → follow-up 2-3 jam kemudian

Jika tidak ada event yang terdeteksi, kembalikan array kosong.

followUpAt harus dalam format ISO 8601 (contoh: "${new Date(Date.now() + 86400000).toISOString()}").
Waktu sekarang dalam ISO: ${now}

Balas HANYA dengan JSON valid (tanpa komentar, tanpa markdown backtick):
{
  "events": [
    {
      "event": "deskripsi singkat event",
      "context": "kutipan konteks dari pesan user",
      "followUpAt": "ISO timestamp kapan harus follow-up"
    }
  ]
}`;

  try {
    const rawResponse = await askAI({
      jid: `followup_extractor_${jid}`,
      userText: prompt,
      systemPrompt: 'Kamu adalah sistem deteksi event. Balas HANYA dengan JSON valid sesuai format. Tidak ada teks lain.',
      forceNew: true,
    });

    const cleaned = rawResponse.replace(/```json|```/gi, '').trim();
    const result = JSON.parse(cleaned);

    if (!result.events?.length) {
      logger.debug({ jid }, '📅 followUp: tidak ada event terdeteksi');
      return;
    }

    // Simpan event baru ke DB — skip duplikat berdasarkan deskripsi event
    const existing = db.find(COLLECTION, { jid }).map((e) => e.event);

    let saved = 0;
    for (const ev of result.events) {
      if (existing.includes(ev.event)) continue;

      await db.insert(COLLECTION, {
        jid,
        event: ev.event,
        context: ev.context ?? '',
        followUpAt: ev.followUpAt,
        done: false,
        createdAt: new Date().toISOString(),
      });
      saved++;
    }

    if (saved > 0) {
      logger.info({ jid, saved }, '📅 followUp: event baru tersimpan');
    }
  } catch (err) {
    logger.warn({ jid, err: err.message }, '⚠️ followUp: gagal ekstrak event');
  }
}

// ─── Follow-up sender ─────────────────────────────────────────────────────────

/**
 * Buat dan kirim pesan follow-up untuk satu event.
 * Dipanggil dari proactiveService saat siklus menemukan event yang due.
 *
 * @param {object} event - dokumen event dari DB
 * @param {object[]} history - chatHistory JID tersebut
 * @param {string} systemPrompt - persona JID tersebut
 */
export async function sendFollowUp(event, history, systemPrompt) {
  const { jid, event: eventDesc, context } = event;

  const recentHistory = history.slice(-10).map((e) => {
    const roleLabel = e.role === 'bot' ? 'Bot' : 'User';
    return `${roleLabel}: ${e.text}`;
  }).join('\n');

  const prompt = `Kamu adalah teman dekat yang melakukan follow-up setelah event yang user ceritakan sebelumnya.

Event yang perlu di-follow-up: "${eventDesc}"
Konteks asli: "${context}"

Riwayat percakapan terakhir:
${recentHistory}

Tulis SATU pesan follow-up yang natural — seperti teman yang ingat dan peduli. 
1-2 kalimat, sesuai gaya percakapan sebelumnya.
Jangan sebut kata "follow-up". Buat terasa natural.

Balas HANYA dengan teks pesan. Tidak ada penjelasan lain.`;

  try {
    const message = await askAI({
      jid: `followup_sender_${jid}`,
      userText: prompt,
      systemPrompt,
      forceNew: true,
    });

    if (!message?.trim()) return;

    const sock = global._sock;
    if (!sock) return;

    await sock.sendMessage(jid, { text: message.trim() });
    await markFollowUpDone(event._id);

    // Catat waktu kirim ke proactiveState untuk cooldown
    const { recordSent } = await import('./proactiveService.js');
    await recordSent(jid).catch(() => {});

    logger.info({ jid, event: eventDesc, preview: message.slice(0, 60) }, '📤 followUp: pesan follow-up terkirim');
  } catch (err) {
    logger.error({ jid, err: err.message }, '❌ followUp: gagal kirim follow-up');
  }
}