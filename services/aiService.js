// services/aiService.js
import axios from 'axios';
import config from '../config/config.js';
import { sessionStore } from './sessionStore.js';
import logger from '../utils/logger.js';

const client = axios.create({
  baseURL: config.ai.baseUrl,
  timeout: config.ai.timeout,
  headers: { 'Content-Type': 'application/json' },
});

/**
 * Internal: kirim satu request ke AI API
 *
 * Pesan PERTAMA (belum ada session):
 *   body.messages = [{ role: 'user', content: '<systemPrompt>\n\n<userText>' }]
 *   → Tidak ada X-Session-ID → server buat session baru
 *
 * Pesan BERIKUTNYA (continue mode):
 *   body.messages = [{ role: 'user', content: '<userText>' }]
 *   header X-Session-ID → server lanjutkan konteks yang ada
 */
async function sendRequest({ jid, userText, systemPrompt, forceNew = false }) {
  const existingSessionId = forceNew ? null : sessionStore.get(jid);
  const isFirstMessage = !existingSessionId;

  const headers = {};
  let content;

  if (isFirstMessage) {
    // Normalisasi system prompt: ganti semua newline dengan spasi
    // agar tidak ter-trigger sebagai "kirim" oleh server Qwen
    const normalizedPrompt = systemPrompt
      ? systemPrompt.replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim()
      : null;

    content = normalizedPrompt
      ? `INSTRUCTION: "${normalizedPrompt}" INPUT: "${userText}"`
      : `INPUT: "${userText}"`;
    logger.info({ jid }, '🆕 Pesan pertama: system prompt + user message dikirim');
  } else {
    // Continue mode: hanya user message, sertakan session header
    headers['X-Session-ID'] = existingSessionId;
    content = `INPUT: "${userText}"`;
    logger.debug({ jid, sessionId: existingSessionId.slice(0, 8) + '...' }, '🔄 Continue mode: user message saja');
  }

  const res = await client.post(
    '/v1/chat/completions',
    {
      model: config.ai.model,
      messages: [{ role: 'user', content }],
      stream: false,
    },
    { headers }
  );

  // Simpan session ID dari response
  const returnedSessionId =
    res.headers['x-session-id'] ||
    res.data?.x_meta?.session_id;

  if (returnedSessionId) {
    sessionStore.set(jid, returnedSessionId);
    if (isFirstMessage) {
      logger.info({ jid, sessionId: returnedSessionId.slice(0, 8) + '...' }, '✅ Session baru tersimpan');
    }
  }

  const reply = res.data?.choices?.[0]?.message?.content;
  if (!reply) throw new Error('Response kosong dari AI API');

  return reply;
}

/**
 * Kirim pesan ke AI, auto-retry jika session expired di server (404)
 */
export async function askAI({ jid, userText, systemPrompt }) {
  try {
    return await sendRequest({ jid, userText, systemPrompt });
  } catch (err) {
    const status = err.response?.status;

    // Session expired di server → hapus local, retry sebagai pesan pertama
    if (status === 404) {
      logger.warn({ jid }, '⚠️ Session expired di server — retry sebagai pesan pertama');
      sessionStore.delete(jid);
      try {
        return await sendRequest({ jid, userText, systemPrompt, forceNew: true });
      } catch (retryErr) {
        logger.error({ jid, err: retryErr.message }, 'AI API error setelah retry');
        return '❌ Maaf, terjadi kesalahan. Coba lagi nanti.';
      }
    }

    const detail = err.response?.data || err.message;
    logger.error({ jid, status, detail }, 'AI API error');

    if (status === 503) return '⚠️ AI sedang sibuk, coba lagi sebentar ya.';
    if (status === 504) return '⏱️ AI terlalu lama merespons, coba lagi.';
    return '❌ Maaf, AI sedang tidak bisa diakses saat ini.';
  }
}

/**
 * Reset sesi — hapus di server dan local store
 */
export async function resetSession(jid) {
  const sessionId = sessionStore.get(jid);
  if (sessionId) {
    try {
      await client.delete(`/v1/sessions/${sessionId}`);
      logger.info({ jid }, 'Session dihapus di server');
    } catch {
      logger.warn({ jid }, 'Gagal hapus session di server (mungkin sudah expired)');
    }
    sessionStore.delete(jid);
  }
}

/**
 * Cek apakah API server online
 */
export async function checkHealth() {
  try {
    const res = await client.get('/health', { timeout: 5000 });
    return res.data?.status === 'ok';
  } catch {
    return false;
  }
}