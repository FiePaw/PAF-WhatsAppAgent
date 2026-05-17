// services/statusService.js
// Membaca status WhatsApp (foto, video, teks) dari owner dan user yang ada di chatHistory.
// Alur:
// 1. Status masuk via event 'messages.upsert' di bot.js (jid === 'status@broadcast')
// 2. Filter: hanya proses jika sender ada di chatJids (pernah ngobrol dengan bot)
// 3. Download media (foto/thumbnail video) atau ambil teks status
// 4. Kirim ke Qwen untuk dianalisa bersama chatHistory dan persona sender
// 5. Qwen generate pesan yang tepat → kirim ke sender
// 6. Catat ke chatHistory sebagai konteks

import { downloadMediaMessage } from '@whiskeysockets/baileys';
import { getAllKnownJids, getHistory, recordMessage } from './chatHistoryService.js';
import { askAI } from './aiService.js';
import { getPersona } from './personaService.js';
import { isOwner } from '../utils/helpers.js';
import { typingDelay } from '../utils/delay.js';
import logger from '../utils/logger.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Cek apakah sender adalah kontak yang dikenal (pernah ada di chatHistory).
 * Owner selalu dikenal meski belum ada di chatHistory.
 *
 * @param {string} senderJid
 * @returns {boolean}
 */
function isKnownContact(senderJid) {
  if (isOwner(senderJid)) return true;
  const knownJids = getAllKnownJids();
  return knownJids.includes(senderJid);
}

/**
 * Deteksi tipe status dari message object Baileys.
 * @param {object} msg
 * @returns {'image' | 'video' | 'text' | 'unknown'}
 */
function detectStatusType(msg) {
  if (msg.message?.imageMessage) return 'image';
  if (msg.message?.videoMessage) return 'video';
  if (msg.message?.conversation || msg.message?.extendedTextMessage?.text) return 'text';
  return 'unknown';
}

/**
 * Ambil caption dari status (untuk foto/video).
 * @param {object} msg
 * @returns {string}
 */
function extractCaption(msg) {
  return (
    msg.message?.imageMessage?.caption ||
    msg.message?.videoMessage?.caption ||
    msg.message?.conversation ||
    msg.message?.extendedTextMessage?.text ||
    ''
  );
}

/**
 * Download foto status sebagai base64 attachment.
 * @param {object} sock
 * @param {object} msg
 * @returns {Promise<Array|null>} attachments array atau null
 */
async function downloadImageStatus(sock, msg) {
  try {
    const buffer = await downloadMediaMessage(
      msg, 'buffer', {},
      { logger, reuploadRequest: sock.updateMediaMessage }
    );
    const mimeType = msg.message.imageMessage.mimetype || 'image/jpeg';
    const base64 = buffer.toString('base64');
    return [{ filename: `status_${Date.now()}.jpg`, data: base64, mime_type: mimeType }];
  } catch (err) {
    logger.warn({ err: err.message }, '⚠️ statusService: gagal download foto status');
    return null;
  }
}

/**
 * Ambil thumbnail video status sebagai base64 attachment.
 * Baileys menyediakan jpegThumbnail di dalam videoMessage.
 * @param {object} msg
 * @returns {Array|null} attachments array atau null
 */
function extractVideoThumbnail(msg) {
  try {
    const thumb = msg.message?.videoMessage?.jpegThumbnail;
    if (!thumb) return null;

    // thumb bisa berupa Buffer atau base64 string
    const base64 = Buffer.isBuffer(thumb)
      ? thumb.toString('base64')
      : Buffer.from(thumb).toString('base64');

    return [{ filename: `status_thumb_${Date.now()}.jpg`, data: base64, mime_type: 'image/jpeg' }];
  } catch (err) {
    logger.warn({ err: err.message }, '⚠️ statusService: gagal ambil thumbnail video');
    return null;
  }
}

/**
 * Format chatHistory menjadi teks percakapan untuk dimasukkan ke prompt Qwen.
 * @param {object[]} history
 * @returns {string}
 */
function formatHistory(history) {
  if (!history?.length) return 'Belum ada riwayat percakapan dengan kontak ini.';

  return history
    .slice(-20) // ambil 20 pesan terakhir agar prompt tidak terlalu panjang
    .map((e) => {
      const time = new Date(e.timestamp).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
      const roleLabel = e.role === 'bot' ? '🤖 Bot' : '👤 User';
      return `[${time}] ${roleLabel}: ${e.text}`;
    })
    .join('\n');
}

// ─── Prompt Builder ───────────────────────────────────────────────────────────

/**
 * Buat prompt analisa status untuk Qwen.
 *
 * @param {object} options
 * @param {string}   options.senderJid
 * @param {string}   options.statusType  - 'image' | 'video' | 'text'
 * @param {string}   options.caption     - caption atau teks status
 * @param {object[]} options.history     - chatHistory JID ini
 * @param {boolean}  options.owner       - apakah sender adalah owner
 * @returns {string}
 */
function buildStatusPrompt({ senderJid, statusType, caption, history, owner }) {
  const now = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
  const contactType = owner ? 'Owner (kamu sendiri)' : 'User/kontak';

  const mediaDesc = {
    image: 'Foto',
    video: 'Video (thumbnail dilampirkan)',
    text:  'Teks',
  }[statusType] ?? 'Status';

  const captionSection = caption?.trim()
    ? `Caption/teks status: "${caption.trim()}"`
    : 'Tidak ada caption.';

  const historySection = formatHistory(history);

  return `Kamu adalah asisten WhatsApp yang cerdas dan empatik. Seseorang baru saja memposting status WhatsApp dan kamu ingin merespons dengan pesan yang tepat, natural, dan personal.

=== WAKTU SEKARANG ===
${now}

=== INFO STATUS ===
Dari: ${contactType} (${senderJid})
Tipe: ${mediaDesc}
${captionSection}
${statusType !== 'text' ? '\n[Media dilampirkan untuk kamu lihat]' : ''}

=== RIWAYAT PERCAKAPAN SEBELUMNYA ===
${historySection}

=== INSTRUKSI ===
Berdasarkan status yang diposting dan riwayat percakapan di atas:
1. Pahami konteks dan suasana status tersebut (senang, sedih, semangat, santai, dll)
2. Buat pesan balasan yang natural — seperti teman yang merespons status WhatsApp
3. Pesan harus relevan dengan isi status, personal (merujuk konteks percakapan jika ada), dan tidak terasa seperti bot
4. Jika kamu punya cukup konteks dari riwayat percakapan, gunakan untuk membuat pesan lebih personal
5. Panjang pesan: singkat hingga sedang (1–3 kalimat), tidak perlu panjang

Balas HANYA dengan teks pesan yang akan dikirim. Tidak perlu penjelasan, tidak perlu format JSON, langsung pesannya saja.`;
}

// ─── Core Logic ───────────────────────────────────────────────────────────────

/**
 * Handle satu status masuk.
 * Dipanggil dari bot.js saat event 'messages.upsert' dengan jid === 'status@broadcast'.
 *
 * @param {object} sock
 * @param {object} msg  - Baileys message object dari status@broadcast
 */
export async function handleStatus(sock, msg) {
  // Status dari diri sendiri → abaikan
  if (msg.key.fromMe) return;

  const senderJid = msg.key.participant || msg.key.remoteJid;
  if (!senderJid) return;

  // Filter: hanya proses kontak yang dikenal (owner atau ada di chatHistory)
  if (!isKnownContact(senderJid)) {
    logger.debug({ senderJid }, '⏭️ statusService: kontak tidak dikenal, skip');
    return;
  }

  const statusType = detectStatusType(msg);

  // Tipe tidak dikenal (dokumen, sticker, dll) → abaikan
  if (statusType === 'unknown') {
    logger.debug({ senderJid, statusType }, '⏭️ statusService: tipe status tidak didukung, skip');
    return;
  }

  const owner = isOwner(senderJid);
  const caption = extractCaption(msg);

  logger.info(
    { senderJid, statusType, owner, hasCaption: !!caption.trim() },
    '📸 statusService: status masuk dari kontak dikenal'
  );

  // ── Step 1: Siapkan attachment (media) ────────────────────────────────────
  let attachments = null;

  if (statusType === 'image') {
    attachments = await downloadImageStatus(sock, msg);
  } else if (statusType === 'video') {
    attachments = extractVideoThumbnail(msg);
    if (!attachments) {
      logger.debug({ senderJid }, '⚠️ statusService: thumbnail video tidak tersedia, lanjut tanpa visual');
    }
  }
  // statusType === 'text' → attachments tetap null, caption sudah cukup

  // ── Step 2: Ambil chatHistory dan persona sender ───────────────────────────
  const history = getHistory(senderJid);
  const { prompt: systemPrompt, model } = getPersona(senderJid, owner);

  // ── Step 3: Kirim ke Qwen untuk analisa dan generate pesan ────────────────
  const userPrompt = buildStatusPrompt({ senderJid, statusType, caption, history, owner });

  let responseMessage;
  try {
    responseMessage = await askAI({
      jid: `status_${senderJid}`,   // session terpisah dari chat session utama
      userText: userPrompt,
      systemPrompt,
      attachments,
      model,
    });

    logger.info(
      { senderJid, preview: responseMessage?.slice(0, 60) },
      '🧠 statusService: Qwen generate pesan untuk status'
    );
  } catch (err) {
    logger.error({ senderJid, err: err.message }, '❌ statusService: gagal generate pesan dari Qwen');
    return;
  }

  if (!responseMessage?.trim()) {
    logger.warn({ senderJid }, '⚠️ statusService: Qwen tidak generate pesan, skip kirim');
    return;
  }

  // ── Step 4: Kirim pesan ke sender ────────────────────────────────────────
  try {
    await typingDelay(sock, senderJid, responseMessage);
    await sock.sendMessage(senderJid, { text: responseMessage.trim() }, { quoted: msg });

    logger.info(
      { senderJid, owner, preview: responseMessage.slice(0, 60) },
      '📤 statusService: pesan terkirim ke sender status'
    );
  } catch (err) {
    logger.error({ senderJid, err: err.message }, '❌ statusService: gagal kirim pesan');
    return;
  }

  // ── Step 5: Catat ke chatHistory ──────────────────────────────────────────
  // Catat konteks status sebagai pesan user agar proactiveService bisa baca nanti
  const statusNote = caption?.trim()
    ? `[Status ${statusType === 'image' ? 'foto' : statusType === 'video' ? 'video' : 'teks'}: "${caption.trim()}"]`
    : `[Status ${statusType === 'image' ? 'foto' : statusType === 'video' ? 'video' : 'teks'} tanpa caption]`;

  recordMessage({
    jid: senderJid,
    role: 'user',
    text: statusNote,
    sender: senderJid,
  }).catch(() => {});

  // Catat balasan bot ke chatHistory
  recordMessage({
    jid: senderJid,
    role: 'bot',
    text: responseMessage.trim(),
    sender: 'bot',
  }).catch(() => {});
}