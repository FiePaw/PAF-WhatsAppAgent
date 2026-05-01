// services/intentSessionService.js
// Dedicated session store untuk intent detection — terpisah dari chat session.
//
// Skenario:
//   Bot start → initIntentSession() dipanggil → kirim system prompt intent ke Qwen
//   → Qwen buat session baru → simpan X-Session-ID sebagai "intent session"
//   Setiap pesan masuk dari owner/user → kirim ke session ini dengan X-Session-ID
//   → Qwen punya konteks percakapan lengkap saat mendeteksi intent
//
// Satu intent session per sender JID.
// Session di-reinit otomatis jika server mengembalikan 404 (expired).

import axios from 'axios';
import config from '../config/config.js';
import logger from '../utils/logger.js';

const client = axios.create({
  baseURL: config.ai.baseUrl,
  timeout: 3000000,
  headers: { 'Content-Type': 'application/json' },
});

// ─── In-memory store intent session ──────────────────────────────────────
// Map<senderJid, sessionId>
// Tidak pakai TTL — intent session di-manage manual (reinit saat 404)
const _store = new Map();

// ─── System prompt untuk intent session ──────────────────────────────────
// Ditulis satu baris — newline menyebabkan Qwen trigger submit terpisah.
// Prompt ini mendefinisikan PERAN Qwen dalam session ini:
//   - Ikuti semua percakapan owner sebagai konteks
//   - Setiap pesan selalu dianalisis: apakah ada intent aksi nyata?
//   - Return JSON, BUKAN respons percakapan biasa
const INTENT_SYSTEM_PROMPT = `Kamu adalah intent detector yang terintegrasi dalam percakapan WhatsApp. Tugasmu adalah memantau setiap pesan dari owner dan menentukan apakah pesan tersebut mengandung instruksi aksi nyata yang harus dieksekusi oleh bot. Daftar intent yang kamu kenali beserta cara mengekstrak params-nya: [1] "sendMessage" - owner ingin mengirim pesan ke nomor WhatsApp lain. Ekstrak: targetNumber (string, angka saja tanpa + atau spasi, format internasional 628xxx) dan message (string, isi pesan yang ingin disampaikan, tulis ulang secara natural orang pertama sesuai maksud owner). Intent ini valid hanya jika nomor target eksplisit disebutkan. Untuk setiap pesan yang kamu terima, balas HANYA dengan raw JSON tanpa markdown tanpa backtick tanpa penjelasan. Jika ada intent: {"intent":"namaIntent","params":{...}}. Jika tidak ada intent atau informasi tidak cukup: {"intent":null,"params":{}}. Kamu tidak boleh membalas dengan teks percakapan biasa dalam session ini, selalu JSON.`;

// ─── Init: buat intent session untuk satu sender ─────────────────────────
/**
 * Inisialisasi intent session untuk sender tertentu.
 * Kirim system prompt sebagai pesan pertama ke Qwen → simpan session ID.
 *
 * @param {string} senderJid
 * @returns {Promise<string|null>} sessionId atau null jika gagal
 */
export async function initIntentSession(senderJid) {
  try {
    logger.info({ senderJid }, '🔧 Inisialisasi intent session...');

    const res = await client.post('/v1/chat/completions', {
      model: config.ai.model,
      messages: [
        {
          role: 'user',
          // Pesan pertama: kirim system prompt + instruksi awal
          // Qwen akan merespons JSON {"intent":null,"params":{}} — kita abaikan hasilnya
          content: `${INTENT_SYSTEM_PROMPT} Pesan pertama untuk inisialisasi: "halo"`,
        },
      ],
      stream: false,
    });

    const sessionId =
      res.headers['x-session-id'] ||
      res.data?.x_meta?.session_id;

    if (!sessionId) {
      logger.warn({ senderJid }, '⚠️ Intent session tidak mengembalikan session ID');
      return null;
    }

    _store.set(senderJid, sessionId);
    logger.info(
      { senderJid, sessionId: sessionId.slice(0, 8) + '...' },
      '✅ Intent session siap'
    );
    return sessionId;
  } catch (err) {
    logger.error({ senderJid, err: err.message }, '❌ Gagal init intent session');
    return null;
  }
}

// ─── Init default: buat intent session untuk owner saat bot start ─────────
/**
 * Dipanggil dari bot.js saat connection.open.
 * Membuat intent session untuk owner secara proaktif.
 */
export async function initOwnerIntentSession() {
  const ownerJid = config.ownerLid || config.ownerJid;
  if (!ownerJid) {
    logger.warn('Owner JID belum diset, skip init intent session');
    return;
  }
  await initIntentSession(ownerJid);
}

// ─── Kirim pesan ke intent session & parse hasil ──────────────────────────
/**
 * Kirim teks ke intent session sender dan dapatkan hasil deteksi intent.
 * Jika session belum ada atau expired (404), auto-reinit dulu.
 *
 * @param {string} senderJid
 * @param {string} text - Teks pesan dari owner/user
 * @returns {Promise<{ intent: string|null, params: object }>}
 */
export async function detectIntentWithSession(senderJid, text) {
  let sessionId = _store.get(senderJid);

  // Session belum ada → init dulu
  if (!sessionId) {
    sessionId = await initIntentSession(senderJid);
    if (!sessionId) {
      logger.warn({ senderJid }, 'Intent session tidak tersedia, fallback intent null');
      return { intent: null, params: {} };
    }
  }

  return await _sendToIntentSession(senderJid, sessionId, text);
}

// ─── Internal: kirim ke session dengan auto-reinit jika 404 ──────────────
async function _sendToIntentSession(senderJid, sessionId, text, isRetry = false) {
  try {
    const res = await client.post(
      '/v1/chat/completions',
      {
        model: config.ai.model,
        messages: [{ role: 'user', content: text }],
        stream: false,
      },
      {
        headers: { 'X-Session-ID': sessionId },
      }
    );

    // Update session ID jika server mengembalikan yang baru
    const newSessionId =
      res.headers['x-session-id'] ||
      res.data?.x_meta?.session_id;

    if (newSessionId && newSessionId !== sessionId) {
      _store.set(senderJid, newSessionId);
    }

    const raw = res.data?.choices?.[0]?.message?.content?.trim();
    if (!raw) return { intent: null, params: {} };

    logger.debug({ senderJid, raw: raw.slice(0, 120) }, '🔍 Intent session response');

    // Strip markdown backtick jika Qwen menambahkan
    const cleaned = raw.replace(/```json|```/gi, '').trim();
    const parsed = JSON.parse(cleaned);

    return {
      intent: parsed.intent || null,
      params: parsed.params || {},
    };
  } catch (err) {
    const status = err.response?.status;

    // Session expired di server → reinit sekali
    if (status === 404 && !isRetry) {
      logger.warn({ senderJid }, '⚠️ Intent session expired di server, reinit...');
      _store.delete(senderJid);
      const newSessionId = await initIntentSession(senderJid);
      if (!newSessionId) return { intent: null, params: {} };
      return await _sendToIntentSession(senderJid, newSessionId, text, true);
    }

    logger.warn({ senderJid, err: err.message }, '⚠️ Intent session error, fallback null');
    return { intent: null, params: {} };
  }
}

// ─── Hapus intent session untuk sender ───────────────────────────────────
export function deleteIntentSession(senderJid) {
  _store.delete(senderJid);
  logger.debug({ senderJid }, 'Intent session dihapus dari store');
}

// ─── List semua intent session aktif ─────────────────────────────────────
export function listIntentSessions() {
  return Array.from(_store.entries()).map(([jid, sessionId]) => ({
    jid,
    sessionId: sessionId.slice(0, 8) + '...',
  }));
}