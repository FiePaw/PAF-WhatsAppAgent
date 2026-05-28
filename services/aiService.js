// services/aiService.js
import axios from 'axios';
import config from '../config/config.js';
import { sessionStore } from './sessionStore.js';
import logger from '../utils/logger.js';

// ─── Timeout per task_type (sesuai dokumentasi API terbaru) ──────────────────
// chat / web_search  → 120 detik
// create_image       → minimal 180 detik
// create_video       → minimal 300 detik
const TASK_TIMEOUTS = {
  chat:         900_000, // 8 menit
  web_search:   900_000, // 5 menit
  create_image: 900_000, // 10 menit
  create_video: 900_000, // 15 menit
};

const client = axios.create({
  baseURL: config.ai.baseUrl,
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
 *
 * Task types khusus (create_image, create_video, web_search):
 *   → Selalu session baru (tidak pakai X-Session-ID)
 *   → URL media ada di response.urls (bukan choices[0].message.content)
 *
 * @param {object} options
 * @param {string}   options.jid
 * @param {string}   options.userText
 * @param {string}   [options.systemPrompt]
 * @param {boolean}  [options.forceNew=false]
 * @param {string}   [options.thinkMode]        - "auto" | "thinking" | "fast" (default server: "fast")
 * @param {Array}    [options.attachments]       - [{ filename, data (base64), mime_type? }]
 * @param {string}   [options.taskType]          - "chat" | "create_image" | "create_video" | "web_search"
 * @returns {Promise<{ text: string, urls: string[] }>}
 */
async function sendRequest({ jid, userText, systemPrompt, forceNew = false, thinkMode, attachments, taskType, model }) {
  const isSpecialTask = taskType && taskType !== 'chat';

  // task_type khusus selalu session baru — tidak pakai X-Session-ID
  const existingSessionId = (forceNew || isSpecialTask) ? null : sessionStore.get(jid);
  const isFirstMessage = !existingSessionId;

  const headers = {};
  let content;

  if (isFirstMessage) {
    // Normalisasi system prompt: ganti semua newline dengan spasi
    const normalizedPrompt = systemPrompt
      ? systemPrompt.replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim()
      : null;

    content = normalizedPrompt
      ? `INSTRUCTION: "${normalizedPrompt}" INPUT: "${userText}"`
      : `INPUT: "${userText}"`;
    logger.info({ jid, taskType: taskType || 'chat' }, '🆕 Pesan pertama: system prompt + user message dikirim');
  } else {
    headers['X-Session-ID'] = existingSessionId;
    content = `INPUT: "${userText}"`;
    logger.debug({ jid, sessionId: existingSessionId.slice(0, 8) + '...' }, '🔄 Continue mode: user message saja');
  }

  // Build request body — gunakan model override dari persona, fallback ke config
  const body = {
    model: model || config.ai.model,
    messages: [{ role: 'user', content }],
    stream: false,
  };

  // task_type — opsional, default server adalah "chat"
  if (taskType && taskType !== 'chat') {
    body.task_type = taskType;
    logger.info({ jid, taskType }, '🎯 Request dengan task_type khusus');
  }

  // think_mode — opsional, default server adalah "fast"
  if (thinkMode) {
    body.think_mode = thinkMode;
  }

  // attachments — opsional, array of { filename, data (base64), mime_type? }
  if (Array.isArray(attachments) && attachments.length > 0) {
    body.attachments = attachments;
    logger.debug({ jid, attachmentCount: attachments.length }, '📎 Request dengan attachment');
  }

  // Pilih timeout sesuai task_type
  const timeout = TASK_TIMEOUTS[taskType] ?? TASK_TIMEOUTS.chat;

  const res = await client.post('/v1/chat/completions', body, { headers, timeout });

  // Simpan session ID dari response — hanya untuk task chat biasa
  if (!isSpecialTask) {
    const returnedSessionId =
      res.headers['x-session-id'] ||
      res.data?.x_meta?.session_id;

    if (returnedSessionId) {
      sessionStore.set(jid, returnedSessionId);
      if (isFirstMessage) {
        logger.info({ jid, sessionId: returnedSessionId.slice(0, 8) + '...' }, '✅ Session baru tersimpan');
      }
    }
  }

  const text = res.data?.choices?.[0]?.message?.content ?? null;
  // urls berisi URL media untuk create_image / create_video; selalu [] untuk chat & web_search
  const urls = Array.isArray(res.data?.urls) ? res.data.urls : [];

  // Untuk task khusus boleh tidak ada text (misal create_video hanya return urls)
  if (!text && urls.length === 0) throw new Error('Response kosong dari AI API');

  return { text, urls };
}

/**
 * Kirim pesan chat ke AI, auto-retry jika session expired di server (404)
 *
 * @param {object} options
 * @param {string}  options.jid
 * @param {string}  options.userText
 * @param {string}  [options.systemPrompt]
 * @param {string}  [options.thinkMode]      - "auto" | "thinking" | "fast"
 * @param {Array}   [options.attachments]    - [{ filename, data (base64), mime_type? }]
 * @returns {Promise<string>} teks balasan AI
 */
export async function askAI({ jid, userText, systemPrompt, thinkMode, attachments, model }) {
  try {
    const { text } = await sendRequest({ jid, userText, systemPrompt, thinkMode, attachments, taskType: 'chat', model });
    return text;
  } catch (err) {
    const status = err.response?.status;

    // Session expired di server → hapus local, retry sebagai pesan pertama
    if (status === 404) {
      logger.warn({ jid }, '⚠️ Session expired di server — retry sebagai pesan pertama');
      sessionStore.delete(jid);
      try {
        const { text } = await sendRequest({ jid, userText, systemPrompt, thinkMode, attachments, forceNew: true, taskType: 'chat', model });
        return text;
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
 * Generate gambar menggunakan Qwen (task_type: create_image).
 * URL gambar ada di array yang di-return, bukan di teks.
 * Generate gambar membutuhkan waktu ~20–60 detik; timeout di-set 180 detik.
 *
 * @param {object} options
 * @param {string}  options.jid
 * @param {string}  options.prompt        - deskripsi gambar yang ingin dibuat
 * @param {string}  [options.accountModel] - nama akun spesifik, default pakai config
 * @returns {Promise<{ text: string|null, urls: string[] }>}
 */
export async function generateImage({ jid, prompt, accountModel }) {
  try {
    const model = accountModel || config.ai.model;
    logger.info({ jid, prompt: prompt.slice(0, 60) }, '🖼️ Request generate gambar...');

    const res = await client.post(
      '/v1/chat/completions',
      {
        model,
        task_type: 'create_image',
        messages: [{ role: 'user', content: prompt }],
        stream: false,
      },
      { timeout: TASK_TIMEOUTS.create_image }
    );

    const text = res.data?.choices?.[0]?.message?.content ?? null;
    const urls = Array.isArray(res.data?.urls) ? res.data.urls : [];

    logger.info({ jid, urlCount: urls.length }, '✅ Gambar berhasil di-generate');
    return { text, urls };
  } catch (err) {
    const status = err.response?.status;
    const detail = err.response?.data || err.message;
    logger.error({ jid, status, detail }, '❌ Gagal generate gambar');
    throw err;
  }
}

/**
 * Generate video menggunakan Qwen (task_type: create_video).
 * URL video ada di array yang di-return.
 * Generate video bisa 60–180 detik; timeout di-set 300 detik.
 *
 * @param {object} options
 * @param {string}  options.jid
 * @param {string}  options.prompt        - deskripsi video yang ingin dibuat
 * @param {string}  [options.accountModel] - nama akun spesifik, default pakai config
 * @returns {Promise<{ text: string|null, urls: string[] }>}
 */
export async function generateVideo({ jid, prompt, accountModel }) {
  try {
    const model = accountModel || config.ai.model;
    logger.info({ jid, prompt: prompt.slice(0, 60) }, '🎬 Request generate video...');

    const res = await client.post(
      '/v1/chat/completions',
      {
        model,
        task_type: 'create_video',
        messages: [{ role: 'user', content: prompt }],
        stream: false,
      },
      { timeout: TASK_TIMEOUTS.create_video }
    );

    const text = res.data?.choices?.[0]?.message?.content ?? null;
    const urls = Array.isArray(res.data?.urls) ? res.data.urls : [];

    logger.info({ jid, urlCount: urls.length }, '✅ Video berhasil di-generate');
    return { text, urls };
  } catch (err) {
    const status = err.response?.status;
    const detail = err.response?.data || err.message;
    logger.error({ jid, status, detail }, '❌ Gagal generate video');
    throw err;
  }
}

/**
 * Web search menggunakan Qwen (task_type: web_search).
 * Output berupa teks, field urls selalu [].
 *
 * @param {object} options
 * @param {string}  options.jid
 * @param {string}  options.query         - query pencarian
 * @param {string}  [options.accountModel] - nama akun spesifik, default pakai config
 * @returns {Promise<string>} hasil pencarian sebagai teks
 */
export async function webSearch({ jid, query, accountModel }) {
  try {
    const model = accountModel || config.ai.model;
    logger.info({ jid, query: query.slice(0, 60) }, '🔍 Request web search...');

    const res = await client.post(
      '/v1/chat/completions',
      {
        model,
        task_type: 'web_search',
        messages: [{ role: 'user', content: query }],
        stream: false,
      },
      { timeout: TASK_TIMEOUTS.web_search }
    );

    const text = res.data?.choices?.[0]?.message?.content;
    if (!text) throw new Error('Response kosong dari web search');

    logger.info({ jid }, '✅ Web search selesai');
    return text;
  } catch (err) {
    const status = err.response?.status;
    const detail = err.response?.data || err.message;
    logger.error({ jid, status, detail }, '❌ Gagal web search');
    throw err;
  }
}

/**
 * Daftar akun/model yang tersedia di server (GET /v1/models).
 * Listing dinamis — mencerminkan cookie aktif di worker.
 *
 * @returns {Promise<string[]>} array nama akun, misal ['account1', 'account2', 'account6']
 */
export async function listModels() {
  try {
    const res = await client.get('/v1/models', { timeout: 10_000 });
    return (res.data?.data ?? []).map((m) => m.id);
  } catch (err) {
    logger.warn({ err: err.message }, '⚠️ Gagal ambil daftar model dari server');
    return [];
  }
}

/**
 * Deskripsikan konteks sebuah gambar menggunakan Qwen vision.
 * Menggunakan session terpisah (forceNew) agar tidak mencemari session chat user/owner.
 * Hasil deskripsi disimpan ke chatHistory sebagai teks oleh caller.
 *
 * @param {object} options
 * @param {string}  options.jid         - JID pengirim (untuk logging)
 * @param {Array}   options.attachments - [{ filename, data (base64), mime_type }]
 * @param {string}  [options.caption]   - caption gambar jika ada (opsional)
 * @returns {Promise<string|null>} deskripsi gambar dalam bahasa Indonesia, atau null jika gagal
 */
export async function describeImage({ jid, attachments, caption }) {
  const captionNote = caption?.trim()
    ? `Caption dari pengirim: "${caption.trim()}"\n\n`
    : '';

  const prompt = `${captionNote}Deskripsikan gambar ini secara lengkap dan jelas. Jelaskan:
- Apa yang terlihat di gambar (objek, orang, tempat, aktivitas)
- Suasana atau konteks keseluruhan gambar
- Informasi penting lain yang relevan dari gambar

Tulis deskripsi dalam Bahasa Indonesia, padat dan informatif (2-4 kalimat).`;

  try {
    logger.info({ jid, hasCaption: !!caption }, '🖼️ Mendeskripsikan gambar dengan Qwen vision...');

    // Gunakan session terpisah + forceNew agar tidak mengganggu session chat user/owner
    const { text } = await sendRequest({
      jid: `image_desc_${jid}_${Date.now()}`,
      userText: prompt,
      attachments,
      forceNew: true,
      taskType: 'chat',
    });

    logger.info({ jid }, '✅ Deskripsi gambar selesai');
    return text;
  } catch (err) {
    const status = err.response?.status;
    const detail = err.response?.data || err.message;
    logger.error({ jid, status, detail }, '❌ Gagal mendeskripsikan gambar');
    return null;
  }
}

// ─── Segmented Reply ──────────────────────────────────────────────────────────

/**
 * System prompt injeksi untuk segmented reply.
 * Ditambahkan di awal system prompt yang sudah ada agar Qwen tahu
 * harus return JSON segmen — persona asli tetap utuh di bawahnya.
 */
const SEGMENTED_SYSTEM_PREFIX = `INSTRUKSI FORMAT REPLY (WAJIB DIIKUTI):
Kamu harus membalas dalam format JSON berikut. JANGAN menulis apapun di luar JSON.

Format:
{"segments":[{"text":"...","delay":1.5},{"text":"...","delay":2.0}]}

Aturan:
- "segments" adalah array pesan yang akan dikirim satu per satu secara berurutan
- "text" adalah isi pesan (plain text, tanpa markdown)
- "delay" adalah jeda dalam detik sebelum pesan ini dikirim (0.5 – 3.0), ditentukan sendiri olehmu agar terasa natural
- Segmen pertama selalu delay 0 (langsung)
- Pecah reply menjadi beberapa segmen jika terasa natural seperti orang mengetik di WhatsApp
- Untuk reply singkat/lugas, boleh hanya 1 segmen
- Maksimal 5 segmen per reply
- JANGAN gunakan markdown di dalam "text"

Contoh:
{"segments":[{"text":"emm..","delay":0},{"text":"aku enggak malu kok","delay":1.5},{"text":"emang kamu gak keberatan?","delay":2.0}]}

SETELAH instruksi format ini, ikuti persona dan instruksi berikut:
---
`;

const MAX_SEGMENT_DELAY = 3.0;
const MAX_RETRY = 3;

/**
 * Parse raw string dari Qwen menjadi array segmen yang valid.
 * Return null jika gagal.
 *
 * @param {string} raw
 * @returns {{ text: string, delay: number }[] | null}
 */
function parseSegments(raw) {
  try {
    // Bersihkan markdown fence jika ada
    const cleaned = raw.replace(/```json|```/gi, '').trim();

    // Cari JSON object pertama yang valid
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) return null;

    const parsed = JSON.parse(match[0]);

    if (!Array.isArray(parsed.segments) || parsed.segments.length === 0) return null;

    // Validasi dan normalize tiap segmen
    const segments = parsed.segments
      .filter((s) => s && typeof s.text === 'string' && s.text.trim())
      .map((s, i) => ({
        text: s.text.trim(),
        // Segmen pertama selalu delay 0 (langsung composing)
        delay: i === 0 ? 0 : Math.min(Math.max(parseFloat(s.delay) || 1.0, 0.5), MAX_SEGMENT_DELAY),
      }));

    return segments.length > 0 ? segments : null;
  } catch {
    return null;
  }
}

/**
 * Kirim pesan ke AI dan return array segmen untuk dikirim satu per satu.
 * Retry hingga MAX_RETRY kali jika Qwen tidak return JSON valid.
 * Fallback: return 1 segmen dengan teks mentah jika semua retry gagal.
 *
 * @param {object} options — sama dengan askAI
 * @param {string}  options.jid
 * @param {string}  options.userText
 * @param {string}  [options.systemPrompt]
 * @param {string}  [options.thinkMode]
 * @param {Array}   [options.attachments]
 * @param {string}  [options.model]
 * @returns {Promise<{ text: string, delay: number }[]>}
 */
export async function askAISegmented({ jid, userText, systemPrompt, thinkMode, attachments, model }) {
  // Inject instruksi segmentasi di depan system prompt yang ada
  const wrappedSystemPrompt = systemPrompt
    ? `${SEGMENTED_SYSTEM_PREFIX}${systemPrompt}`
    : SEGMENTED_SYSTEM_PREFIX.trimEnd();

  let lastRawResponse = null;

  for (let attempt = 1; attempt <= MAX_RETRY; attempt++) {
    try {
      const { text } = await sendRequest({
        jid,
        userText,
        systemPrompt: wrappedSystemPrompt,
        thinkMode: thinkMode || 'fast',
        attachments,
        taskType: 'chat',
        model,
        // Retry ke-2+ paksa session baru agar tidak terkontaminasi jawaban salah sebelumnya
        forceNew: attempt > 1,
      });

      lastRawResponse = text;
      const segments = parseSegments(text);

      if (segments) {
        if (attempt > 1) {
          logger.info({ jid, attempt }, '✅ askAISegmented: JSON valid setelah retry');
        }
        return segments;
      }

      logger.warn({ jid, attempt, preview: text?.slice(0, 80) }, `⚠️ askAISegmented: JSON tidak valid (attempt ${attempt}/${MAX_RETRY})`);
    } catch (err) {
      const status = err.response?.status;
      logger.warn({ jid, attempt, err: err.message, status }, `⚠️ askAISegmented: error saat request (attempt ${attempt}/${MAX_RETRY})`);

      // Session expired → hapus dan lanjut retry
      if (status === 404) {
        sessionStore.delete(jid);
      }
    }
  }

  // Semua retry gagal — fallback ke 1 segmen plain text
  logger.error({ jid }, `❌ askAISegmented: ${MAX_RETRY}x retry gagal, fallback ke plain text`);

  // Coba kirim teks mentah sebagai 1 segmen jika ada
  if (lastRawResponse?.trim()) {
    return [{ text: lastRawResponse.trim(), delay: 0 }];
  }

  // Benar-benar tidak ada response
  return [{ text: '❌ Maaf, terjadi kesalahan. Coba lagi nanti.', delay: 0 }];
}

/**
 * Warm-up owner AI session saat bot start.
 * Kirim persona owner sebagai system prompt dengan dummy input ringan.
 * Session ID tersimpan ke sessionStore sehingga percakapan pertama owner
 * langsung dalam mode "continue" (persona sudah di-set di server).
 *
 * @param {string} ownerJid   - JID owner (@s.whatsapp.net atau @lid)
 * @param {string} systemPrompt - persona string dari persona.json
 */
export async function warmupOwnerSession(ownerJid, systemPrompt, model) {
  // Jika session sudah ada (misalnya bot restart cepat), skip
  if (sessionStore.get(ownerJid)) {
    logger.info({ ownerJid }, '⚡ Owner session sudah ada, skip warmup');
    return;
  }

  try {
    logger.info({ ownerJid }, '🔥 Warming up owner AI session dengan persona...');
    // Kirim init message — jawaban AI diabaikan, hanya sesi + persona yang diperlukan
    await sendRequest({
      jid: ownerJid,
      userText: 'init',
      systemPrompt,
      forceNew: true,
      taskType: 'chat',
      model,
    });
    logger.info({ ownerJid }, '✅ Owner AI session berhasil di-warmup');
  } catch (err) {
    logger.warn({ ownerJid, err: err.message }, '⚠️ Gagal warmup owner AI session (akan retry saat pesan pertama)');
  }
}

/**
 * Reset sesi — hapus di server dan local store
 */
export async function resetSession(jid) {
  const sessionId = sessionStore.get(jid);
  if (sessionId) {
    try {
      await client.delete(`/v1/sessions/${sessionId}`, { timeout: 10_000 });
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