// services/intentSessionService.js
// Dedicated session store untuk intent detection — terpisah dari chat session.
//
// Skenario:
//   Bot start → initIntentSession() dipanggil → build daftar tools dari
//   triggered plugins → kirim ke Qwen (config.ai.taskModel) dengan `tools`
//   (function-calling, lihat API_USAGE.md §9) → Qwen buat session baru →
//   simpan X-Session-ID sebagai "intent session"
//   Setiap pesan masuk dari owner/user → kirim ke session ini dengan
//   X-Session-ID + `tools` yang sama → Qwen punya konteks percakapan
//   lengkap saat mendeteksi intent, dan MEMANGGIL tool yang sesuai jika
//   ada aksi nyata (bukan lagi menulis raw JSON bebas di teks).
//
// ─── Migrasi dari raw-JSON ke tool-calling (§9 API_USAGE.md) ─────────────
//   Sebelumnya: system prompt menyuruh Qwen balas HANYA raw JSON
//   `{"intent": "...", "params": {...}}` — rawan gagal parse ("JSON tidak
//   valid") karena bergantung pada disiplin model menulis JSON bebas di
//   tengah teks percakapan.
//   Sekarang: setiap triggered plugin mendaftarkan dirinya sebagai SATU
//   function/tool (nama = intent, parameters = JSON Schema dari
//   plugin.parameters). Qwen memanggil tool yang sesuai via `tool_calls`
//   yang sudah diparse & divalidasi bentuknya oleh gateway sendiri — kita
//   tidak perlu regex/JSON.parse manual atas teks bebas lagi. Jika tidak
//   ada aksi yang perlu dilakukan, Qwen cukup TIDAK memanggil tool apapun.
//
// Satu intent session per sender JID. Selalu pakai Qwen — intent detection
// bukan chat user-facing, jadi masuk kategori "tugas lain".
//
// Catatan migrasi PAF-Model: gateway TIDAK mengembalikan 404 khusus untuk
// session expired (lihat API_USAGE.md §12) — error yang mungkin muncul
// adalah 400/422/500/502/504. Reinit dilakukan untuk error apapun, bukan
// hanya 404. Juga: sesi TIDAK punya TTL otomatis lagi (§6.2.1) — tapi
// intent session ini kita anggap "seumur proses bot" (di-reinit hanya saat
// error), bukan dikelola lewat sessionStore/config.sessionTtl seperti sesi
// chat biasa.

import axios from 'axios';
import config from '../config/config.js';
import { extractToolCall } from '../utils/toolCalling.js';
import logger from '../utils/logger.js';

const client = axios.create({
  baseURL: config.ai.baseUrl,
  timeout: 120_000, // 120 detik (sesuai rekomendasi API untuk task chat/web_search)
  headers: { 'Content-Type': 'application/json' },
});

// ─── In-memory store intent session ─────────────────────────────────────
// Map<senderJid, sessionId>
const _store = new Map();

// ─── Cache tools + system prompt yang sudah di-build ────────────────────
// Di-build sekali saat initOwnerIntentSession() pertama kali dipanggil,
// lalu dipakai ulang untuk semua session berikutnya.
let _cachedSystemPrompt = null;
let _cachedTools = null;

// ─── Base system prompt ──────────────────────────────────────────────────
// Mendefinisikan PERAN Qwen dalam session ini: pantau pesan, panggil tool
// yang sesuai jika ada aksi nyata, atau tidak melakukan apapun jika tidak.
const BASE_PROMPT = `Kamu adalah intent detector yang terintegrasi dalam percakapan WhatsApp. Tugasmu adalah memantau setiap pesan dari owner dan menentukan apakah pesan tersebut mengandung instruksi aksi nyata yang harus dieksekusi oleh bot. Kamu punya akses ke sejumlah tools/function — panggil TEPAT SATU tool yang paling sesuai jika pesan mengandung instruksi aksi nyata dan informasinya cukup untuk mengisi parameter tool tersebut. Jika pesan TIDAK mengandung instruksi aksi, atau informasi belum cukup untuk memanggil tool manapun dengan yakin, JANGAN memanggil tool apapun — cukup balas dengan teks singkat apa saja (balasan teks ini tidak akan ditampilkan ke siapapun, hanya dianggap "tidak ada aksi").`;

// ─── Build daftar tools dari triggered plugins ──────────────────────────
/**
 * Build daftar `tools` (function-calling, §9 API_USAGE.md) dari semua
 * triggered plugin yang sudah di-load, plus system prompt dasarnya.
 * Import getIntentToolSchemas() dilakukan secara lazy (bukan top-level)
 * untuk menghindari circular dependency — triggeredPluginHandler import
 * intentSessionService, jadi intentSessionService tidak boleh import
 * triggeredPluginHandler di top-level.
 *
 * @returns {Promise<{ systemPrompt: string, tools: object[] }>}
 */
async function _buildToolsAndPrompt() {
  if (_cachedSystemPrompt && _cachedTools) {
    return { systemPrompt: _cachedSystemPrompt, tools: _cachedTools };
  }

  // Lazy import untuk hindari circular dependency
  const { getIntentToolSchemas } = await import('../core/triggeredPluginHandler.js');
  const tools = getIntentToolSchemas();

  if (tools.length === 0) {
    logger.warn('⚠️ Tidak ada tool dari plugin manapun — intent detector tidak akan mengenali aksi apapun');
  } else {
    logger.info({ intentCount: tools.length }, '✅ Daftar tools intent detector berhasil di-build');
  }

  _cachedSystemPrompt = BASE_PROMPT;
  _cachedTools = tools;
  return { systemPrompt: _cachedSystemPrompt, tools: _cachedTools };
}

// ─── Reset cache (jika diperlukan reload) ───────────────────────────────
export function resetSystemPromptCache() {
  _cachedSystemPrompt = null;
  _cachedTools = null;
  logger.debug('Tools & system prompt cache intent detector di-reset');
}

// ─── Init: buat intent session untuk satu sender ────────────────────────
/**
 * Inisialisasi intent session untuk sender tertentu.
 * Build tools + system prompt terlebih dahulu, lalu kirim ke Qwen sebagai
 * pesan pertama → simpan session ID.
 *
 * @param {string} senderJid
 * @returns {Promise<string|null>} sessionId atau null jika gagal
 */
export async function initIntentSession(senderJid) {
  try {
    logger.info({ senderJid }, '🔧 Inisialisasi intent session...');

    const { systemPrompt, tools } = await _buildToolsAndPrompt();

    const res = await client.post('/v1/chat/completions', {
      model: config.ai.taskModel,
      messages: [
        { role: 'user', content: `${systemPrompt} Pesan pertama untuk inisialisasi: "halo"` },
      ],
      tools,
      tool_choice: 'auto',
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

// ─── Init default: buat intent session untuk owner saat bot start ──────
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

// ─── Kirim pesan ke intent session & parse hasil ────────────────────────
/**
 * Kirim teks (dan gambar opsional) ke intent session sender dan dapatkan
 * hasil deteksi intent — sekarang via tool_calls, bukan JSON.parse raw text.
 * Jika session belum ada atau error, auto-reinit dulu.
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

// ─── Internal: kirim ke session dengan auto-reinit jika error ──────────
async function _sendToIntentSession(senderJid, sessionId, text, isRetry = false, attachments = null) {
  try {
    const { tools } = await _buildToolsAndPrompt();

    const body = {
      model: config.ai.taskModel,
      messages: [{ role: 'user', content: text }],
      tools,
      tool_choice: 'auto',
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

    const message = res.data?.choices?.[0]?.message ?? null;
    const toolCall = extractToolCall(message);

    if (!toolCall) {
      logger.debug({ senderJid, preview: message?.content?.slice(0, 80) }, '🔍 Intent session: tidak ada tool dipanggil (tidak ada aksi)');
      return { intent: null, params: {} };
    }

    logger.debug({ senderJid, intent: toolCall.name }, '🔍 Intent session: tool call terdeteksi');

    return { intent: toolCall.name, params: toolCall.args };
  } catch (err) {
    const status = err.response?.status;

    // PAF-Model gateway tidak punya kode error khusus untuk "session expired"
    // (lihat API_USAGE.md §12: hanya 400/422/500/502/504). Jadi untuk error
    // apapun yang bukan retry, kita coba reinit sekali sebagai fallback.
    if (!isRetry) {
      logger.warn({ senderJid, status, err: err.message }, '⚠️ Intent session error, coba reinit sekali...');
      _store.delete(senderJid);
      resetSystemPromptCache();
      const newSessionId = await initIntentSession(senderJid);
      if (!newSessionId) return { intent: null, params: {} };
      return await _sendToIntentSession(senderJid, newSessionId, text, true, attachments);
    }

    logger.warn({ senderJid, status, err: err.message }, '⚠️ Intent session error setelah reinit, fallback null');
    return { intent: null, params: {} };
  }
}

// ─── Hapus intent session untuk sender ──────────────────────────────────
export function deleteIntentSession(senderJid) {
  _store.delete(senderJid);
  logger.debug({ senderJid }, 'Intent session dihapus dari store');
}

// ─── List semua intent session aktif ────────────────────────────────────
export function listIntentSessions() {
  return Array.from(_store.entries()).map(([jid, sessionId]) => ({
    jid,
    sessionId: sessionId.slice(0, 8) + '...',
  }));
}
