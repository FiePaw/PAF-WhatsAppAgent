// services/aiService.js
// ─────────────────────────────────────────────────────────────────────────
// Integrasi ke PAF-Model gateway (lihat API_USAGE.md di FiePaw/PAF-Model).
// Gateway ini fronting DUA backend browser-automation:
//   - deepseek → dipakai untuk semua CHAT/interaksi natural dengan user
//   - qwen     → dipakai untuk SEMUA tugas lain: intent detection, deskripsi
//                gambar, generate gambar/video, web search, dan pesan chat
//                yang mengandung gambar (DeepSeek butuh model_tab "vision"
//                khusus, Qwen tidak perlu apa-apa untuk terima gambar)
//
// Perbedaan penting vs API lama:
//   - field "model" WAJIB persis "deepseek" | "qwen" | "<backend>(<account>)"
//     (regex ketat di gateway) — tidak bisa lagi kirim nama akun polos.
//   - task_type ("create_image"/"create_video"/"web_search") HANYA berlaku
//     untuk backend qwen.
//   - System prompt: DeepSeek membaca system prompt dari message ber-role
//     "system" (dikirim hanya di pesan pertama, karena browser session sudah
//     menyimpan konteksnya). Qwen TIDAK membaca system message dari array
//     messages sama sekali — makanya untuk Qwen kita tetap pakai trik lama
//     (system prompt digabung ke content: `INSTRUCTION: ... INPUT: ...`).
//   - Tidak ada endpoint hapus session di server — reset hanya menghapus
//     mapping jid→sessionId di sisi bot (lihat resetSession()).
//   - Tidak ada 404 khusus untuk session expired. DeepSeek memberi sinyal
//     `x_meta.mode_fallback: true` ketika server diam-diam memulai
//     percakapan baru karena session lama sudah hilang — kita hanya log ini
//     (tidak perlu retry, karena response yang diterima tetap valid).
// ─────────────────────────────────────────────────────────────────────────
import axios from 'axios';
import config from '../config/config.js';
import { sessionStore } from './sessionStore.js';
import logger from '../utils/logger.js';

// ─── Timeout ──────────────────────────────────────────────────────────────
// Dokumentasi PAF-Model merekomendasikan HTTP client timeout ≥ PAF_REQUEST_TIMEOUT
// (default server 330 detik). Kita pakai timeout longgar untuk semua jenis
// request karena backend berbasis browser-automation bisa lambat.
const TASK_TIMEOUTS = {
  chat:         900_000, // 15 menit
  web_search:   900_000,
  create_image: 900_000,
  create_video: 900_000,
};

const client = axios.create({
  baseURL: config.ai.baseUrl,
  headers: { 'Content-Type': 'application/json' },
});

/**
 * Tentukan backend ("deepseek" | "qwen") dari string model.
 * Mendukung bentuk polos ("deepseek", "qwen") maupun ber-akun
 * ("deepseek(account1)", "qwen(account1.json)").
 *
 * @param {string} model
 * @returns {'deepseek'|'qwen'}
 */
function resolveBackend(model) {
  return model?.startsWith('qwen') ? 'qwen' : 'deepseek';
}

/**
 * Internal: kirim satu request ke PAF-Model gateway.
 *
 * Pesan PERTAMA (belum ada session untuk jid ini):
 *   - DeepSeek → messages = [{role:'system', content: systemPrompt}, {role:'user', content: userText}]
 *   - Qwen     → messages = [{role:'user', content: 'INSTRUCTION: "..." INPUT: "..."'}]
 *   → Tidak kirim header X-Session-ID → server buat session baru
 *
 * Pesan BERIKUTNYA (continue mode):
 *   → messages = [{role:'user', content: userText atau 'INPUT: "..."'}]
 *   → header X-Session-ID → server lanjutkan konteks yang ada
 *
 * Task types khusus (create_image, create_video, web_search) — Qwen only:
 *   → Selalu session baru (tidak pakai X-Session-ID)
 *   → URL media ada di response.urls (catatan: menurut API_USAGE.md §10,
 *     field ini saat ini TIDAK di-surface oleh gateway untuk task_type
 *     Qwen — treat sebagai best-effort, bisa jadi selalu kosong)
 *
 * @param {object} options
 * @param {string}   options.jid
 * @param {string}   options.userText
 * @param {string}   [options.systemPrompt]
 * @param {boolean}  [options.forceNew=false]
 * @param {string}   [options.thinkMode]        - "auto" | "thinking" | "fast" (arti beda per backend)
 * @param {Array}    [options.attachments]      - [{ filename, data (base64), mime_type? }]
 * @param {string}   [options.taskType]         - "chat" | "create_image" | "create_video" | "web_search" (qwen only)
 * @param {string}   [options.model]            - "deepseek" | "qwen" | "<backend>(<account>)"
 * @returns {Promise<{ text: string, urls: string[], backend: string }>}
 */
async function sendRequest({ jid, userText, systemPrompt, forceNew = false, thinkMode, attachments, taskType, model }) {
  const resolvedModel = model || config.ai.chatModel;
  const backend = resolveBackend(resolvedModel);
  const isSpecialTask = taskType && taskType !== 'chat';

  // task_type khusus selalu session baru — tidak pakai X-Session-ID
  const existingSessionId = (forceNew || isSpecialTask) ? null : sessionStore.get(jid);
  const isFirstMessage = !existingSessionId;

  const headers = {};
  let messages;

  // Normalisasi system prompt: ganti semua newline dengan spasi
  const normalizedPrompt = systemPrompt
    ? systemPrompt.replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim()
    : null;

  if (backend === 'deepseek') {
    // DeepSeek: system prompt via role "system" — hanya perlu dikirim saat
    // pesan pertama, karena browser session akan menyimpan konteksnya.
    messages = [];
    if (isFirstMessage && normalizedPrompt) {
      messages.push({ role: 'system', content: normalizedPrompt });
    }
    messages.push({ role: 'user', content: userText });
  } else {
    // Qwen: tidak baca system message dari array messages — tetap pakai
    // trik gabung ke content seperti API lama.
    const content = isFirstMessage
      ? (normalizedPrompt ? `INSTRUCTION: "${normalizedPrompt}" INPUT: "${userText}"` : `INPUT: "${userText}"`)
      : `INPUT: "${userText}"`;
    messages = [{ role: 'user', content }];
  }

  if (isFirstMessage) {
    logger.info({ jid, backend, taskType: taskType || 'chat' }, '🆕 Pesan pertama: session baru dibuat');
  } else {
    headers['X-Session-ID'] = existingSessionId;
    logger.debug({ jid, backend, sessionId: existingSessionId.slice(0, 8) + '...' }, '🔄 Continue mode: user message saja');
  }

  const body = {
    model: resolvedModel,
    messages,
    stream: false,
  };

  // task_type — hanya berlaku untuk backend qwen (diabaikan gateway untuk deepseek)
  if (taskType && taskType !== 'chat') {
    body.task_type = taskType;
    logger.info({ jid, taskType }, '🎯 Request dengan task_type khusus');
  }

  // think_mode — opsional, arti beda per backend (lihat §7 API_USAGE.md)
  if (thinkMode) {
    body.think_mode = thinkMode;
  }

  // attachments — opsional, array of { filename, data (base64), mime_type? }
  if (Array.isArray(attachments) && attachments.length > 0) {
    body.attachments = attachments;
    logger.debug({ jid, attachmentCount: attachments.length }, '📎 Request dengan attachment');

    // DeepSeek butuh model_tab "vision" khusus untuk terima gambar.
    // Normalnya kita sudah routing gambar ke Qwen di layer atas, tapi
    // ditambahkan sebagai jaring pengaman jika suatu saat DeepSeek dipaksa.
    if (backend === 'deepseek') {
      body.model_tab = 'vision';
    }
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

  // Sinyal dari DeepSeek: session lama hilang, server diam-diam mulai
  // percakapan baru. Response tetap valid, cukup dicatat sebagai info.
  if (res.data?.x_meta?.mode_fallback) {
    logger.warn({ jid, backend }, '⚠️ mode_fallback: session lama hilang di server, percakapan baru dimulai otomatis');
  }

  const text = res.data?.choices?.[0]?.message?.content ?? null;
  // urls berisi URL media untuk create_image / create_video (qwen) — lihat
  // catatan di komentar function ini soal keterbatasan gateway saat ini.
  const urls = Array.isArray(res.data?.urls) ? res.data.urls : [];

  // Untuk task khusus boleh tidak ada text (misal create_video hanya return urls)
  if (!text && urls.length === 0) throw new Error('Response kosong dari AI API');

  return { text, urls, backend };
}

/**
 * Kirim pesan chat ke AI.
 *
 * Model dipilih otomatis, kecuali eksplisit di-override lewat parameter `model`:
 *   - `model` diisi eksplisit      → pakai itu (mis. task background yang
 *     sengaja butuh Qwen walau tidak ada gambar, seperti scheduled plugin)
 *   - Ada attachments (gambar)     → config.ai.taskModel (qwen) — DeepSeek
 *     butuh mode vision khusus, Qwen tidak perlu apa-apa
 *   - Tidak ada attachments/model  → config.ai.chatModel (deepseek)
 *
 * Catatan: API_USAGE.md §12 tidak mendefinisikan status khusus untuk
 * "session expired" (bukan 404 seperti API lama) — kalau session lama
 * hilang, DeepSeek diam-diam mulai percakapan baru (lihat mode_fallback
 * di sendRequest()) dan tetap mengembalikan response sukses. Jadi tidak
 * perlu logic retry khusus expiry di sini.
 *
 * @param {object} options
 * @param {string}  options.jid
 * @param {string}  options.userText
 * @param {string}  [options.systemPrompt]
 * @param {string}  [options.thinkMode]      - "auto" | "thinking" | "fast"
 * @param {Array}   [options.attachments]    - [{ filename, data (base64), mime_type? }]
 * @param {string}  [options.model]          - override eksplisit "deepseek" | "qwen" | "<backend>(<account>)"
 * @returns {Promise<string>} teks balasan AI
 */
export async function askAI({ jid, userText, systemPrompt, thinkMode, attachments, model: modelOverride }) {
  const hasImage = Array.isArray(attachments) && attachments.length > 0;
  const model = modelOverride || (hasImage ? config.ai.taskModel : config.ai.chatModel);

  try {
    const { text } = await sendRequest({ jid, userText, systemPrompt, thinkMode, attachments, taskType: 'chat', model });
    return text;
  } catch (err) {
    const status = err.response?.status;
    const detail = err.response?.data?.detail || err.message;
    logger.error({ jid, status, detail }, 'AI API error');

    if (status === 504) return '⏱️ Tidak ada worker AI tersedia saat ini, coba lagi sebentar.';
    if (status === 502) return '⚠️ AI (Qwen) gagal merespons, coba lagi.';
    if (status === 500) return '⚠️ Terjadi kesalahan di server AI, coba lagi.';
    if (status === 400 || status === 422) return '❌ Permintaan ke AI tidak valid.';
    return '❌ Maaf, AI sedang tidak bisa diakses saat ini.';
  }
}

/**
 * Generate gambar menggunakan Qwen (task_type: create_image, Qwen-only).
 * URL gambar ada di array yang di-return, bukan di teks.
 *
 * ⚠️ Catatan dari API_USAGE.md §10: gateway saat ini TIDAK men-surface field
 * `urls`/`task_type` dari worker Qwen ke response HTTP — jadi `urls` bisa
 * jadi selalu kosong sampai ini diperbaiki di sisi server PAF-Model.
 *
 * @param {object} options
 * @param {string}  options.jid
 * @param {string}  options.prompt        - deskripsi gambar yang ingin dibuat
 * @param {string}  [options.accountModel] - override "qwen(accountX.json)", default config.ai.taskModel
 * @returns {Promise<{ text: string|null, urls: string[] }>}
 */
export async function generateImage({ jid, prompt, accountModel }) {
  try {
    const model = accountModel || config.ai.taskModel;
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
 * Generate video menggunakan Qwen (task_type: create_video, Qwen-only).
 * URL video ada di array yang di-return (lihat catatan keterbatasan di
 * generateImage() di atas — berlaku sama untuk create_video).
 *
 * @param {object} options
 * @param {string}  options.jid
 * @param {string}  options.prompt        - deskripsi video yang ingin dibuat
 * @param {string}  [options.accountModel] - override "qwen(accountX.json)", default config.ai.taskModel
 * @returns {Promise<{ text: string|null, urls: string[] }>}
 */
export async function generateVideo({ jid, prompt, accountModel }) {
  try {
    const model = accountModel || config.ai.taskModel;
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
 * Web search menggunakan Qwen (task_type: web_search, Qwen-only).
 * Output berupa teks, field urls selalu [].
 *
 * @param {object} options
 * @param {string}  options.jid
 * @param {string}  options.query         - query pencarian
 * @param {string}  [options.accountModel] - override "qwen(accountX.json)", default config.ai.taskModel
 * @returns {Promise<string>} hasil pencarian sebagai teks
 */
export async function webSearch({ jid, query, accountModel }) {
  try {
    const model = accountModel || config.ai.taskModel;
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
 * Daftar model/akun yang tersedia di server (GET /v1/models).
 * Listing dinamis — mencerminkan akun/cookie aktif di worker.
 * Bentuk id sesuai PAF-Model: "deepseek", "qwen", atau bentuk ber-akun
 * seperti "deepseek(account1)" / "qwen(account1.json)".
 *
 * @returns {Promise<string[]>} array id model, misal ['deepseek', 'qwen', 'deepseek(account1)']
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
    // Qwen (taskModel) — tidak perlu model_tab khusus untuk terima gambar
    const { text } = await sendRequest({
      jid: `image_desc_${jid}_${Date.now()}`,
      userText: prompt,
      attachments,
      forceNew: true,
      taskType: 'chat',
      model: config.ai.taskModel,
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

Aturan format:
- "segments" adalah array pesan yang dikirim satu per satu secara berurutan
- "text" adalah isi pesan (plain text, tanpa markdown)
- "delay" adalah jeda dalam detik sebelum pesan ini dikirim (0.5 – 3.0)
- Segmen pertama selalu delay 0 (langsung)
- JANGAN gunakan markdown di dalam "text"

CARA MENENTUKAN JUMLAH SEGMEN — baca konteks pesan user dengan cermat:

1 segmen → gunakan jika:
- User sedang curhat, cerita panjang, atau membahas hal serius/emosional
  → balas dengan satu pesan panjang yang thoughtful, jangan dipecah
- User bertanya sesuatu yang butuh jawaban detail/informatif
  → satu blok jawaban yang lengkap lebih baik dari pecahan
- User kirim pesan panjang → balas dengan bobot yang setara, 1 segmen panjang
- Situasi serius: masalah, keluhan, pertanyaan mendalam
- WAJIB: jika memilih 1 segmen, panjang "text" minimal 1000 karakter — jangan tanggung

2–3 segmen → gunakan jika:
- Percakapan santai dan ringan, obrolan sehari-hari
- User kirim pesan pendek/kasual → balas dengan gaya chat natural yang mengalir
- Ada jeda natural dalam pikiran (ragu, mikir, lanjut)
- Ekspresi emosi ringan yang lebih natural jika dipecah
  contoh: "hehe" → "iya bener juga sih" → "tapi..."

Banyak segmen → gunakan jika:
- User sangat ekspresif, antusias, atau percakapan penuh energi
- Respons memang terdiri dari banyak pikiran terpisah yang mengalir natural

Prinsip utama: IKUTI ENERGI dan KONTEKS dari pesan user.
Jangan selalu 2 segmen. Kalau 1 cukup, pakai 1. Kalau konteksnya mengalir banyak, boleh banyak.

Contoh 1 segmen (curhat serius):
{"segments":[{"text":"aku ngerti banget perasaan kamu, itu pasti berat banget dijalani sendirian. kalau mau cerita lebih, aku dengerin kok","delay":0}]}

Contoh 3 segmen (chat santai):
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
 * Retry hingga MAX_RETRY kali jika model tidak return JSON valid.
 * Fallback: return 1 segmen dengan teks mentah jika semua retry gagal.
 *
 * Model dipilih otomatis (sama seperti askAI() — lihat penjelasan di sana),
 * kecuali di-override eksplisit lewat parameter `model`.
 *
 * @param {object} options
 * @param {string}  options.jid
 * @param {string}  options.userText
 * @param {string}  [options.systemPrompt]
 * @param {string}  [options.thinkMode]
 * @param {Array}   [options.attachments]
 * @param {string}  [options.model] - override eksplisit "deepseek" | "qwen" | "<backend>(<account>)"
 * @returns {Promise<{ text: string, delay: number }[]>}
 */
export async function askAISegmented({ jid, userText, systemPrompt, thinkMode, attachments, model: modelOverride }) {
  const hasImage = Array.isArray(attachments) && attachments.length > 0;
  const model = modelOverride || (hasImage ? config.ai.taskModel : config.ai.chatModel);

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
        thinkMode: thinkMode || 'auto',
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
 * Selalu pakai config.ai.chatModel (deepseek) — warmup ini untuk chat biasa.
 *
 * @param {string} ownerJid   - JID owner (@s.whatsapp.net atau @lid)
 * @param {string} systemPrompt - persona string dari persona.json
 */
export async function warmupOwnerSession(ownerJid, systemPrompt) {
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
      model: config.ai.chatModel,
    });
    logger.info({ ownerJid }, '✅ Owner AI session berhasil di-warmup');
  } catch (err) {
    logger.warn({ ownerJid, err: err.message }, '⚠️ Gagal warmup owner AI session (akan retry saat pesan pertama)');
  }
}

/**
 * Reset sesi — hapus mapping jid→sessionId di sisi bot.
 *
 * ⚠️ PAF-Model gateway TIDAK menyediakan endpoint untuk menghapus session di
 * server (lihat API_USAGE.md §6.2: "There is no mechanism to end/delete a
 * session explicitly via the API"). Percakapan lama di browser
 * chat.deepseek.com / chat.qwen.ai akan tetap ada sampai TTL server habis
 * sendiri — kita hanya bisa memastikan pesan berikutnya dari jid ini
 * dikirim sebagai "pesan pertama" (session baru) dari sisi bot.
 */
export async function resetSession(jid) {
  if (sessionStore.get(jid)) {
    sessionStore.delete(jid);
    logger.info({ jid }, 'Session lokal dihapus — pesan berikutnya akan mulai sebagai session baru');
  }
}

/**
 * Cek apakah API server online (≥1 worker terhubung).
 * Bentuk response: { status: "healthy" | "no_workers", workers: {...} }
 */
export async function checkHealth() {
  try {
    const res = await client.get('/health', { timeout: 5000 });
    return res.data?.status === 'healthy';
  } catch {
    return false;
  }
}