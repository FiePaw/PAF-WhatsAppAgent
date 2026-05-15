// services/intentSessionService.js
// Dedicated session store untuk intent detection — terpisah dari chat session.
//
// Skenario:
//   Bot start → initIntentSession() dipanggil → build system prompt dari base + definisi plugin
//   → kirim ke Qwen → Qwen buat session baru → simpan X-Session-ID sebagai "intent session"
//   Setiap pesan masuk dari owner/user → kirim ke session ini dengan X-Session-ID
//   → Qwen punya konteks percakapan lengkap saat mendeteksi intent
//
// Satu intent session per sender JID.
// Session di-reinit otomatis jika server mengembalikan 404 (expired).

import axios from 'axios';
import config from '../config/config.js';
import { getIntentSessionModel } from './personaService.js';
import logger from '../utils/logger.js';

const client = axios.create({
  baseURL: config.ai.baseUrl,
  timeout: 120_000, // 120 detik (sesuai rekomendasi API untuk task chat/web_search)
  headers: { 'Content-Type': 'application/json' },
});

// ─── In-memory store intent session ──────────────────────────────────────
// Map<senderJid, sessionId>
const _store = new Map();

// ─── Cache system prompt yang sudah di-build ──────────────────────────────
// Di-build sekali saat initOwnerIntentSession() pertama kali dipanggil,
// lalu dipakai ulang untuk semua session berikutnya.
let _cachedSystemPrompt = null;

// ─── Base system prompt ───────────────────────────────────────────────────
// Mendefinisikan PERAN dan FORMAT output Qwen dalam session ini.
// Daftar intent di-inject secara dinamis dari triggered plugins.
const BASE_PROMPT = `Kamu adalah intent detector yang terintegrasi dalam percakapan WhatsApp. Tugasmu adalah memantau setiap pesan dari owner dan menentukan apakah pesan tersebut mengandung instruksi aksi nyata yang harus dieksekusi oleh bot. Untuk setiap pesan yang kamu terima, balas HANYA dengan raw JSON tanpa markdown tanpa backtick tanpa penjelasan. Jika ada intent: {"intent":"namaIntent","params":{...}}. Jika tidak ada intent atau informasi tidak cukup: {"intent":null,"params":{}}. Kamu tidak boleh membalas dengan teks percakapan biasa dalam session ini, selalu JSON.`;

// ─── Build system prompt ──────────────────────────────────────────────────
/**
 * Build final system prompt dengan mengagregasi intentDefinition dari semua triggered plugin.
 * Import getIntentDefinitions() dilakukan secara lazy (bukan top-level) untuk menghindari
 * circular dependency — triggeredPluginHandler import intentSessionService,
 * jadi intentSessionService tidak boleh import triggeredPluginHandler di top-level.
 *
 * @returns {Promise<string>}
 */
async function _buildSystemPrompt() {
  if (_cachedSystemPrompt) return _cachedSystemPrompt;

  // Lazy import untuk hindari circular dependency
  const { getIntentDefinitions } = await import('../core/triggeredPluginHandler.js');
  const definitions = getIntentDefinitions();

  if (definitions.length === 0) {
    logger.warn('⚠️ Tidak ada intentDefinition dari plugin manapun — intent detector tidak akan mengenali aksi apapun');
    _cachedSystemPrompt = BASE_PROMPT;
    return _cachedSystemPrompt;
  }

  // Format: [1] "intentName" - deskripsi... [2] "intentName2" - deskripsi...
  const intentList = definitions
    .map((d, i) => `[${i + 1}] ${d.definition}`)
    .join(' ');

  _cachedSystemPrompt = `${BASE_PROMPT} Daftar intent yang kamu kenali beserta cara mengekstrak params-nya: ${intentList}`;

  logger.info({ intentCount: definitions.length }, '✅ System prompt intent detector berhasil di-build');
  return _cachedSystemPrompt;
}

// ─── Reset cache (jika diperlukan reload) ────────────────────────────────
export function resetSystemPromptCache() {
  _cachedSystemPrompt = null;
  logger.debug('System prompt cache di-reset');
}

// ─── Init: buat intent session untuk satu sender ─────────────────────────
/**
 * Inisialisasi intent session untuk sender tertentu.
 * Build system prompt terlebih dahulu (dari base + definisi plugin),
 * lalu kirim ke Qwen sebagai pesan pertama → simpan session ID.
 *
 * @param {string} senderJid
 * @returns {Promise<string|null>} sessionId atau null jika gagal
 */
export async function initIntentSession(senderJid) {
  try {
    logger.info({ senderJid }, '🔧 Inisialisasi intent session...');

    const systemPrompt = await _buildSystemPrompt();

    // Gunakan model khusus intent session jika diset di persona.json, fallback ke config
    const intentModel = getIntentSessionModel() || config.ai.model;

    const res = await client.post('/v1/chat/completions', {
      model: intentModel,
      messages: [
        {
          role: 'user',
          // Pesan pertama: kirim system prompt + instruksi awal
          // Qwen akan merespons JSON {"intent":null,"params":{}} — kita abaikan hasilnya
          content: `${systemPrompt} Pesan pertama untuk inisialisasi: "halo"`,
        },
      ],
      stream: false,
      think_mode: 'fast', // intent detection tidak butuh deep reasoning
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
 * Kirim teks (dan gambar opsional) ke intent session sender dan dapatkan hasil deteksi intent.
 * Jika session belum ada atau expired (404), auto-reinit dulu.
 *
 * @param {string} senderJid
 * @param {string} text - Teks pesan dari owner/user (bisa "[gambar dikirim]" jika tanpa caption)
 * @param {Array|null} [attachments] - Array attachment gambar dari messageHandler
 * @returns {Promise<{ intent: string|null, params: object }>}
 */
export async function detectIntentWithSession(senderJid, text, attachments = null) {
  let sessionId = _store.get(senderJid);

  // Session belum ada → init dulu
  if (!sessionId) {
    sessionId = await initIntentSession(senderJid);
    if (!sessionId) {
      logger.warn({ senderJid }, 'Intent session tidak tersedia, fallback intent null');
      return { intent: null, params: {} };
    }
  }

  return await _sendToIntentSession(senderJid, sessionId, text, false, attachments);
}

// ─── Internal: kirim ke session dengan auto-reinit jika 404 ──────────────
async function _sendToIntentSession(senderJid, sessionId, text, isRetry = false, attachments = null) {
  try {
    const intentModel = getIntentSessionModel() || config.ai.model;
    const body = {
      model: intentModel,
      messages: [{ role: 'user', content: text }],
      stream: false,
      think_mode: 'fast',
    };

    // Sertakan attachment gambar jika ada
    if (Array.isArray(attachments) && attachments.length > 0) {
      body.attachments = attachments;
      logger.debug({ senderJid, attachmentCount: attachments.length }, '🖼️ Intent session: kirim dengan attachment');
    }

    const res = await client.post(
      '/v1/chat/completions',
      body,
      { headers: { 'X-Session-ID': sessionId } }
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
      resetSystemPromptCache();
      const newSessionId = await initIntentSession(senderJid);
      if (!newSessionId) return { intent: null, params: {} };
      return await _sendToIntentSession(senderJid, newSessionId, text, true, attachments);
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