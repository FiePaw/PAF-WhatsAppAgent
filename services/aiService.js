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
// ─── Perubahan penting per revisi API_USAGE.md terbaru ───────────────────
//   1. Sesi TIDAK PUNYA TTL otomatis di server lagi (§6.2.1) — sesi hidup
//      selamanya sampai di-DELETE eksplisit. Bot sekarang WAJIB mengelola
//      lifetime sesi sendiri (lihat sessionStore.js + config.sessionTtl).
//   2. Endpoint baru `DELETE /v1/sessions/{session_id}` (§4.5/§6.2.1) —
//      resetSession() sekarang benar-benar menghapus sesi di server, bukan
//      cuma mapping lokal seperti sebelumnya.
//   3. `tools` (OpenAI function-calling shape, §9) didukung di kedua
//      backend — dipakai untuk task background (intent detection, botBrain,
//      economicNews) alih-alih menyuruh model menulis raw JSON di tengah
//      teks lalu kita regex sendiri. Lihat askAITool() di bawah dan
//      utils/toolCalling.js.
//   4. System prompt: DeepSeek membaca system prompt dari message ber-role
//      "system" (dikirim hanya di pesan pertama, karena browser session
//      sudah menyimpan konteksnya). Qwen TIDAK membaca system message dari
//      array messages sama sekali — makanya untuk Qwen kita tetap pakai
//      trik lama (system prompt digabung ke content: `INSTRUCTION: ... INPUT: ...`).
//   5. `x_meta.mode_fallback: true` menandakan sesi browser DeepSeek hilang
//      di server dan diam-diam mulai percakapan baru — sekarang kita respons
//      aktif: trigger memoryService.summarizeAndRemember() di background
//      agar konteks yang sempat ada tidak hilang percuma (lihat sendRequest).
// ─────────────────────────────────────────────────────────────────────────
import axios from 'axios';
import config from '../config/config.js';
import { sessionStore } from './sessionStore.js';
import { extractToolCall } from '../utils/toolCalling.js';
import logger from '../utils/logger.js';

// ─── Timeout ────────────────────────────────────────────────────────────
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
 *   → Jika useMemory true: memori jangka panjang (memoryService) diinjeksi
 *     ke systemPrompt di sini — HANYA pada pesan pertama, karena itulah
 *     titik di mana "konteks lama" perlu diisi ulang secara eksplisit.
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
 * @param {object[]} [options.tools]            - definisi tools (OpenAI function-calling shape, §9)
 * @param {string}   [options.memoryJid]        - jid ASLI untuk lookup memoryService, jika berbeda dari `jid`
 *                                                 (dipakai saat jid adalah namespace internal, mis. `brain_followup_<jid>`)
 * @param {boolean}  [options.useMemory=true]   - jika true & isFirstMessage, injeksi memori jangka panjang ke systemPrompt
 * @returns {Promise<{ text: string, urls: string[], backend: string, toolCall: {name, args}|null }>}
 */
async function sendRequest({
  jid, userText, systemPrompt, forceNew = false, thinkMode, attachments, taskType, model,
  tools, memoryJid, useMemory = true,
}) {
  const resolvedModel = model || config.ai.chatModel;
  const backend = resolveBackend(resolvedModel);
  const isSpecialTask = taskType && taskType !== 'chat';

  // task_type khusus selalu session baru — tidak pakai X-Session-ID
  const existingSessionId = (forceNew || isSpecialTask) ? null : sessionStore.get(jid);
  const isFirstMessage = !existingSessionId;

  const headers = {};
  let messages;

  // Normalisasi system prompt: ganti semua newline dengan spasi
  let normalizedPrompt = systemPrompt
    ? systemPrompt.replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim()
    : null;

  // ─── Injeksi memori jangka panjang — HANYA saat pesan pertama sesi ─────
  // Ini adalah titik kunci solusi "kehilangan konteks": setiap kali sesi
  // benar-benar baru dimulai (baik pertama kali chat, maupun setelah sesi
  // lama di-reset/TTL/mode_fallback), kita isi ulang system prompt dengan
  // ringkasan sesi sebelumnya + fakta penting yang sudah pernah diketahui.
  if (isFirstMessage && useMemory && !isSpecialTask) {
    try {
      const { formatMemoryForPrompt } = await import('./memoryService.js');
      const memoryBlock = formatMemoryForPrompt(memoryJid || jid);
      if (memoryBlock) {
        normalizedPrompt = normalizedPrompt ? `${normalizedPrompt}\n\n${memoryBlock}` : memoryBlock;
        logger.debug({ jid: memoryJid || jid }, '🧠 Memori jangka panjang disuntik ke system prompt (sesi baru)');
      }
    } catch (err) {
      logger.warn({ jid, err: err.message }, '⚠️ Gagal muat memori jangka panjang, lanjut tanpa memori');
    }
  }

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
    // trik lama (gabung ke content seperti API lama).
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

  // tools — function-calling shape (§9 API_USAGE.md). Dikirim ulang setiap
  // request (bukan hanya pesan pertama) karena tidak ada dokumentasi resmi
  // bahwa definisi tool ikut "tersimpan" bersama sesi browser.
  if (Array.isArray(tools) && tools.length > 0) {
    body.tools = tools;
    body.tool_choice = 'auto';
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
  // percakapan baru. Response tetap valid — tapi sekarang kita aktif
  // menyelamatkan konteks yang mungkin hilang dengan meringkas chatHistory
  // yang masih tersimpan di sisi bot ke memory bank (fire-and-forget,
  // tidak menunda balasan ke user).
  if (res.data?.x_meta?.mode_fallback) {
    logger.warn({ jid, backend }, '⚠️ mode_fallback: session lama hilang di server, percakapan baru dimulai otomatis');

    if (!isSpecialTask) {
      const realJid = memoryJid || jid;
      import('./memoryService.js')
        .then(({ isRealContactJid, summarizeAndRemember }) => {
          if (isRealContactJid(realJid)) {
            return summarizeAndRemember(realJid, 'mode_fallback');
          }
        })
        .catch((err) => logger.warn({ jid: realJid, err: err.message }, '⚠️ Gagal auto-summarize setelah mode_fallback'));
    }
  }

  const message = res.data?.choices?.[0]?.message ?? null;
  const text = message?.content ?? null;
  const toolCall = extractToolCall(message);
  // urls berisi URL media untuk create_image / create_video (qwen) — lihat
  // catatan di komentar function ini soal keterbatasan gateway saat ini.
  const urls = Array.isArray(res.data?.urls) ? res.data.urls : [];

  // Untuk task khusus boleh tidak ada text (misal create_video hanya return urls)
  if (!text && urls.length === 0 && !toolCall) throw new Error('Response kosong dari AI API');

  return { text, urls, backend, toolCall };
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
 * @param {object} options
 * @param {string}  options.jid
 * @param {string}  options.userText
 * @param {string}  [options.systemPrompt]
 * @param {string}  [options.thinkMode]      - "auto" | "thinking" | "fast"
 * @param {Array}   [options.attachments]    - [{ filename, data (base64), mime_type? }]
 * @param {string}  [options.model]          - override eksplisit "deepseek" | "qwen" | "<backend>(<account>)"
 * @param {string}  [options.memoryJid]      - jid asli untuk lookup memori, jika berbeda dari `jid`
 * @param {boolean} [options.useMemory=true] - injeksi memori jangka panjang pada pesan pertama sesi
 * @param {boolean} [options.forceNew=false]
 * @returns {Promise<string>} teks balasan AI
 */
export async function askAI({ jid, userText, systemPrompt, thinkMode, attachments, model: modelOverride, memoryJid, useMemory, forceNew }) {
  const hasImage = Array.isArray(attachments) && attachments.length > 0;
  const model = modelOverride || (hasImage ? config.ai.taskModel : config.ai.chatModel);

  try {
    const { text } = await sendRequest({ jid, userText, systemPrompt, thinkMode, attachments, taskType: 'chat', model, memoryJid, useMemory, forceNew });
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
 * Kirim pesan ke AI dengan satu/lebih `tools` (function-calling, §9
 * API_USAGE.md) dan langsung kembalikan tool_call yang dipilih model
 * (sudah diparse jadi { name, args }) — menggantikan pola lama "minta AI
 * balas raw JSON lalu kita regex/JSON.parse manual sendiri".
 *
 * Cocok untuk task background machine-to-machine: intent detection,
 * keputusan botBrain, ekstraksi profil/follow-up, generate berita
 * terstruktur, dll. TIDAK dipakai untuk balasan chat user-facing biasa
 * (askAI/askAISegmented) karena mode tool-calling bisa mengganggu gaya
 * bahasa persona natural.
 *
 * @param {object} options
 * @param {string}   options.jid
 * @param {string}   options.userText
 * @param {string}   [options.systemPrompt]
 * @param {object[]} options.tools           - lihat utils/toolCalling.js buildFunctionTool()
 * @param {string}   [options.model]         - default config.ai.taskModel
 * @param {boolean}  [options.forceNew=true] - default true, task background biasanya one-shot
 * @param {string}   [options.memoryJid]
 * @param {boolean}  [options.useMemory=false] - default false, task background biasanya sudah bawa konteksnya sendiri di prompt
 * @param {string}   [options.thinkMode]
 * @returns {Promise<{ name: string|null, args: object, raw: string|null }>}
 */
export async function askAITool({ jid, userText, systemPrompt, tools, model, forceNew = true, memoryJid, useMemory = false, thinkMode }) {
  const resolvedModel = model || config.ai.taskModel;

  try {
    const { text, toolCall } = await sendRequest({
      jid, userText, systemPrompt, thinkMode, taskType: 'chat',
      model: resolvedModel, forceNew, memoryJid, useMemory, tools,
    });

    if (toolCall) {
      return { name: toolCall.name, args: toolCall.args, raw: text };
    }

    logger.debug({ jid, preview: text?.slice(0, 80) }, 'ℹ️ askAITool: model tidak memanggil tool (dianggap "tidak ada aksi")');
    return { name: null, args: {}, raw: text };
  } catch (err) {
    const status = err.response?.status;
    logger.error({ jid, status, err: err.message }, '❌ askAITool: request gagal');
    return { name: null, args: {}, raw: null };
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
    // useMemory: false — ini task vision satu kali, bukan chat, tidak perlu konteks memori.
    const { text } = await sendRequest({
      jid: `image_desc_${jid}_${Date.now()}`,
      userText: prompt,
      attachments,
      forceNew: true,
      taskType: 'chat',
      model: config.ai.taskModel,
      useMemory: false,
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

// ─── Segmented Reply ────────────────────────────────────────────────────

/**
 * System prompt injeksi untuk segmented reply.
 * Ditambahkan di awal system prompt yang sudah ada agar Qwen/DeepSeek tahu
 * harus return JSON segmen — persona asli tetap utuh di bawahnya.
 */
const SEGMENTED_SYSTEM_PREFIX = `INSTRUKSI FORMAT REPLY (WAJIB DIIKUTI):
Tulis balasanmu sebagai TEKS BIASA (plain text), seperti chat WhatsApp natural. JANGAN gunakan markdown, JANGAN gunakan JSON, JANGAN gunakan format apapun selain teks biasa.

Jika balasanmu terasa lebih natural dipecah jadi beberapa "chat singkat" berurutan (bukan satu jawaban utuh) — pisahkan tiap bagian dengan baris yang HANYA berisi tanda pemisah ###  (tiga tanda pagar, baris sendiri, jangan digabung dengan teks lain).
Jika balasanmu cukup sebagai SATU pesan saja — JANGAN gunakan pemisah ### sama sekali, cukup tulis teksnya langsung.

CARA MENENTUKAN PERLU DIPECAH ATAU TIDAK — baca SINYAL KONTEKS di bawah ini dan konteks pesan user dengan cermat. Sinyal konteks (panjang pesan user, jeda sejak pesan terakhir, kecepatan chat beberapa menit terakhir) diberikan secara EKSPLISIT dalam blok "=== SINYAL KONTEKS ===" jika tersedia — gunakan angka-angka itu sebagai bukti nyata, bukan hanya menerka dari nada teks:

JANGAN dipecah (1 pesan saja) → gunakan jika:
- User sedang curhat, cerita panjang, atau membahas hal serius/emosional
  → balas dengan satu pesan panjang yang thoughtful, jangan dipecah
- User bertanya sesuatu yang butuh jawaban detail/informatif
  → satu blok jawaban yang lengkap lebih baik dari pecahan
- User kirim pesan panjang (lihat "panjang pesan user" di sinyal konteks — >150 karakter cenderung serius) → balas dengan bobot yang setara, 1 pesan panjang
- Jeda sejak pesan terakhir CUKUP LAMA (>30 menit di sinyal konteks) → user baru "kembali", biasanya bawa topik baru yang butuh jawaban utuh, bukan chat cepat
- Situasi serius: masalah, keluhan, pertanyaan mendalam

Dipecah jadi 2-3 bagian → gunakan jika:
- Percakapan santai dan ringan, obrolan sehari-hari
- User kirim pesan pendek/kasual (lihat "panjang pesan user" — <40 karakter biasanya kasual) → balas dengan gaya chat natural yang mengalir
- Kecepatan chat TINGGI (banyak pesan dalam 5 menit terakhir di sinyal konteks) → user sedang aktif ngobrol cepat, ikuti tempo itu dengan balasan yang juga terasa "cepat & mengalir", bukan 1 blok panjang
- Ada jeda natural dalam pikiran (ragu, mikir, lanjut)
- Ekspresi emosi ringan yang lebih natural jika dipecah
  contoh: "hehe" → "iya bener juga sih" → "tapi..."

Dipecah jadi banyak bagian → gunakan jika:
- User sangat ekspresif, antusias, atau percakapan penuh energi
- Kecepatan chat SANGAT TINGGI (chat beruntun dalam hitungan detik/menit) sekaligus pesan singkat-singkat

Prinsip utama: IKUTI ENERGI, KONTEKS, dan SINYAL KONTEKS NUMERIK dari pesan user.
Jangan selalu dipecah. Kalau 1 pesan cukup, jangan pakai pemisah ### sama sekali. Kalau konteksnya mengalir banyak, boleh dipecah jadi beberapa bagian.

Contoh TIDAK dipecah (curhat serius):
aku ngerti banget perasaan kamu, itu pasti berat banget dijalani sendirian. kalau mau cerita lebih, aku dengerin kok

Contoh dipecah 3 bagian (chat santai, kecepatan chat tinggi):
emm..
###
aku enggak malu kok
###
emang kamu gak keberatan?

SETELAH instruksi format ini, ikuti persona dan instruksi berikut:
---
`;

const MAX_SEGMENT_DELAY = 3.0;
const SEGMENT_DELIMITER_RE = /\n?[ \t]*#{3}[ \t]*\n?/g;
const MAX_SEGMENTS = 5; // jaga-jaga kalau model kebanyakan memecah
const MAX_NETWORK_RETRY = 2; // retry HANYA untuk error request/koneksi asli, bukan lagi untuk "format tidak valid"

/**
 * Hitung delay antar-segmen (jeda sebelum bubble berikutnya mulai
 * "mengetik") secara DETERMINISTIK di kode — tidak lagi minta AI
 * mengarang angka delay sendiri (yang sering tidak konsisten dan jadi
 * salah satu penyebab lama "format tidak valid" saat digabung ke JSON).
 * Delay sedikit proporsional ke panjang segmen sebelumnya (mensimulasikan
 * "jeda mikir" sebelum lanjut chat), dibatasi 0.5–MAX_SEGMENT_DELAY detik.
 *
 * @param {string} previousText - teks segmen sebelumnya
 * @returns {number}
 */
function computeInterSegmentDelay(previousText) {
  const base = 0.8 + Math.min((previousText?.length ?? 0) / 120, 1.4);
  return Math.min(Math.max(base, 0.5), MAX_SEGMENT_DELAY);
}

/**
 * Parse raw plain-text dari AI menjadi array segmen — TIDAK LAGI berbasis
 * JSON (lihat CHANGELOG: model chat-tuned seperti DeepSeek sering menolak
 * patuh instruksi "wajib JSON" saat sedang menjawab natural, menyebabkan
 * "JSON tidak valid" berulang + retry mahal karena forceNew membuat sesi
 * baru tiap percobaan). Sekarang: AI menulis plain text biasa, dan HANYA
 * jika ingin dipecah jadi beberapa bubble berurutan, menyisipkan baris
 * pemisah "###" di antaranya. Delay dihitung lokal (deterministik), bukan
 * dari angka yang "dikarang" AI.
 *
 * Fungsi ini SELALU berhasil menghasilkan minimal 1 segmen (tidak pernah
 * return null) — kalau tidak ada delimiter ditemukan, seluruh teks dianggap
 * 1 segmen. Ini adalah default yang AMAN, bukan kegagalan.
 *
 * @param {string} raw
 * @returns {{ text: string, delay: number }[]}
 */
function parseSegments(raw) {
  const cleaned = (raw ?? '').replace(/```/g, '').trim();

  if (!cleaned) {
    return [{ text: '❌ Maaf, terjadi kesalahan. Coba lagi nanti.', delay: 0 }];
  }

  const parts = cleaned
    .split(SEGMENT_DELIMITER_RE)
    .map((p) => p.trim())
    .filter(Boolean);

  const finalParts = (parts.length > 0 ? parts : [cleaned]).slice(0, MAX_SEGMENTS);

  return finalParts.map((text, i) => ({
    text,
    delay: i === 0 ? 0 : computeInterSegmentDelay(finalParts[i - 1]),
  }));
}

/**
 * Bangun blok "=== SINYAL KONTEKS ===" dari objek contextHints agar AI
 * punya angka nyata (bukan hanya tebak-tebakan dari nada teks) saat
 * memutuskan perlu dipecah atau tidak. Lihat pemanggil di
 * core/messageHandler.js — dihitung dari chatHistory sebelum askAISegmented
 * dipanggil.
 *
 * @param {object} [contextHints]
 * @param {number} [contextHints.userMessageLength]   - panjang teks pesan user saat ini
 * @param {number} [contextHints.secondsSinceLastMessage] - jeda sejak pesan terakhir di history
 * @param {number} [contextHints.messagesLastFiveMin]  - jumlah pesan (user+bot) dalam 5 menit terakhir
 * @returns {string} blok teks, atau '' jika tidak ada hints
 */
function buildContextHintsBlock(contextHints) {
  if (!contextHints) return '';

  const lines = ['=== SINYAL KONTEKS ==='];
  let has = false;

  if (typeof contextHints.userMessageLength === 'number') {
    lines.push(`Panjang pesan user saat ini: ${contextHints.userMessageLength} karakter`);
    has = true;
  }
  if (typeof contextHints.secondsSinceLastMessage === 'number') {
    const mins = Math.round(contextHints.secondsSinceLastMessage / 60);
    lines.push(`Jeda sejak pesan terakhir di percakapan ini: ${mins < 1 ? '<1 menit' : `${mins} menit`}`);
    has = true;
  }
  if (typeof contextHints.messagesLastFiveMin === 'number') {
    lines.push(`Jumlah pesan (user+bot) dalam 5 menit terakhir: ${contextHints.messagesLastFiveMin} (${contextHints.messagesLastFiveMin >= 4 ? 'chat cepat/beruntun' : 'chat normal/santai'})`);
    has = true;
  }

  return has ? lines.join('\n') : '';
}

/**
 * Kirim pesan ke AI dan return array segmen untuk dikirim satu per satu.
 *
 * Sejak migrasi ke format plain-text + delimiter "###" (lihat parseSegments
 * di atas), fungsi ini TIDAK LAGI retry karena "format tidak valid" — itu
 * tidak mungkin terjadi lagi (parseSegments selalu berhasil, minimal 1
 * segmen). Retry HANYA dilakukan sekali untuk error request/koneksi asli
 * (network error, 5xx, dll), bukan untuk masalah format.
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
 * @param {string}  [options.model]         - override eksplisit "deepseek" | "qwen" | "<backend>(<account>)"
 * @param {string}  [options.memoryJid]     - jid asli untuk lookup memori, jika berbeda dari `jid`
 * @param {boolean} [options.useMemory=true]
 * @param {object}  [options.contextHints]  - lihat buildContextHintsBlock() — Fix #2: bantu AI memutuskan segmentasi
 * @returns {Promise<{ text: string, delay: number }[]>}
 */
export async function askAISegmented({ jid, userText, systemPrompt, thinkMode, attachments, model: modelOverride, memoryJid, useMemory, contextHints }) {
  const hasImage = Array.isArray(attachments) && attachments.length > 0;
  const model = modelOverride || (hasImage ? config.ai.taskModel : config.ai.chatModel);

  // Fix #2: sinyal konteks numerik (panjang pesan, jeda, kecepatan chat) —
  // diselipkan SETELAH instruksi format, SEBELUM persona, supaya AI punya
  // data nyata untuk memilih perlu dipecah atau tidak alih-alih hanya menerka dari nada.
  const hintsBlock = buildContextHintsBlock(contextHints);

  // Inject instruksi segmentasi di depan system prompt yang ada
  const wrappedSystemPrompt = systemPrompt
    ? `${SEGMENTED_SYSTEM_PREFIX}${hintsBlock ? hintsBlock + '\n\n' : ''}${systemPrompt}`
    : `${SEGMENTED_SYSTEM_PREFIX.trimEnd()}${hintsBlock ? '\n\n' + hintsBlock : ''}`;

  for (let attempt = 1; attempt <= MAX_NETWORK_RETRY; attempt++) {
    try {
      const { text } = await sendRequest({
        jid,
        userText,
        systemPrompt: wrappedSystemPrompt,
        thinkMode: thinkMode || 'auto',
        attachments,
        taskType: 'chat',
        model,
        memoryJid,
        useMemory,
        // Retry (jika ada, karena error koneksi) paksa session baru agar tidak terkontaminasi
        forceNew: attempt > 1,
      });

      if (attempt > 1) {
        logger.info({ jid, attempt }, '✅ askAISegmented: berhasil setelah retry koneksi');
      }
      return parseSegments(text);
    } catch (err) {
      const status = err.response?.status;
      logger.warn({ jid, attempt, err: err.message, status }, `⚠️ askAISegmented: error saat request (attempt ${attempt}/${MAX_NETWORK_RETRY})`);
    }
  }

  // Semua percobaan gagal karena error request/koneksi asli (bukan format)
  logger.error({ jid }, `❌ askAISegmented: ${MAX_NETWORK_RETRY}x percobaan gagal karena error koneksi/request`);
  return [{ text: '❌ Maaf, terjadi kesalahan. Coba lagi nanti.', delay: 0 }];
}

/**
 * Warm-up owner AI session saat bot start.
 * Kirim persona owner sebagai system prompt dengan dummy input ringan.
 * Session ID tersimpan ke sessionStore sehingga percakapan pertama owner
 * langsung dalam mode "continue" (persona sudah di-set di server).
 *
 * Selalu pakai config.ai.chatModel (deepseek) — warmup ini untuk chat biasa.
 * useMemory: true (default) — warmup adalah titik terbaik untuk mengisi
 * ulang konteks dari sesi-sesi sebelumnya begitu bot baru menyala.
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
 * Hapus sesi di SERVER PAF-Model secara eksplisit via
 * `DELETE /v1/sessions/{session_id}` (endpoint baru, lihat API_USAGE.md
 * §4.5/§6.2.1). Dipanggil oleh resetSession() dan oleh sessionStore saat
 * TTL lokal tercapai — sejak sesi tidak lagi punya TTL otomatis di server,
 * inilah satu-satunya cara "membersihkan" sesi yang sudah tidak dipakai.
 *
 * @param {string|null} sessionId
 * @returns {Promise<{ deleted: boolean }>}
 */
export async function deleteRemoteSession(sessionId) {
  if (!sessionId) return { deleted: false };

  try {
    const res = await client.delete(`/v1/sessions/${sessionId}`, { timeout: 15_000 });
    logger.info(
      { sessionId: sessionId.slice(0, 8) + '...', deleted: res.data?.deleted },
      '🗑️ Remote session dihapus dari server AI'
    );
    return res.data;
  } catch (err) {
    // deleted:false / 404-like bukan error fatal — sesi mungkin memang
    // sudah tidak ada di worker mana pun. Cukup log sebagai warning.
    logger.warn(
      { sessionId: sessionId?.slice(0, 8) + '...', err: err.message },
      '⚠️ Gagal hapus remote session (mungkin sudah tidak ada)'
    );
    return { deleted: false };
  }
}

/**
 * Reset sesi — hapus mapping jid→sessionId di sisi bot DAN hapus sesi di
 * server via DELETE /v1/sessions/{id}.
 *
 * Sebelumnya (API lama): tidak ada cara hapus sesi di server, jadi fungsi
 * ini hanya menghapus mapping lokal. Sekarang (lihat API_USAGE.md §6.2.1)
 * ada endpoint resmi untuk itu — dipakai di sini agar sesi benar-benar
 * bersih di kedua sisi, bukan cuma "dilupakan" bot tapi tetap menumpuk di
 * server selamanya.
 *
 * @param {string} jid
 */
export async function resetSession(jid) {
  const sessionId = sessionStore.get(jid);
  if (!sessionId) return;

  sessionStore.delete(jid);
  await deleteRemoteSession(sessionId);
  logger.info({ jid }, 'Session dihapus (lokal + server) — pesan berikutnya akan mulai sebagai session baru');
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
