// services/aiService.js
// ─────────────────────────────────────────────────────────────────────────
// Integrasi ke PAF-Model gateway (lihat API_USAGE.md di FiePaw/PAF-Model).
// Gateway ini fronting TIGA backend browser-automation:
//   - qwen     → dipakai untuk chat/interaksi natural dengan user,
//                plus tugas media & vision: deskripsi gambar/dokumen/video,
//                generate gambar/video, web search.
//   - deepseek → dipakai untuk intent detection & task background berbasis
//                tool-calling (botBrain, memoryService, approval, dll).
//                Kini juga mendukung input gambar/dokumen via attachments.
//   - grok     → didukung untuk chat dan tool-calling universal (§9 API_USAGE.md).
//                Dipakai plugin economicNews via askAITool() & task background.
//
// ─── Perubahan penting per revisi API_USAGE.md & PAF-Model terbaru ───────────
//   1. Sesi TIDAK PUNYA TTL otomatis di server lagi (§6.2.1) — sesi hidup
//      selamanya sampai di-DELETE eksplisit. Bot sekarang WAJIB mengelola
//      lifetime sesi sendiri (lihat sessionStore.js + config.sessionTtl).
//   2. Endpoint baru `DELETE /v1/sessions/{session_id}` (§4.5/§6.2.1) —
//      resetSession() sekarang benar-benar menghapus sesi di server, bukan
//      cuma mapping lokal seperti sebelumnya.
//   3. `tools` (OpenAI function-calling shape, §9) didukung di semua backend
//      (DeepSeek, Qwen, Grok) — dipakai untuk task background (intent detection,
//      botBrain, economicNews) alih-alih menyuruh model menulis raw JSON.
//   4. System prompt terpadu (Unified System Prompt): DeepSeek, Qwen, dan Grok
//      semuanya membaca role "system" dan "developer" yang diekstrak oleh gateway.
//      System prompt diinjeksi ke [SYSTEM CONTEXT] pada SETIAP turn dan TIDAK
//      disimpan di session server, sehingga WAJIB dikirim ulang di setiap request.
//   5. DeepSeek UI Baru & Toggle: Mode Instant/Expert/Vision dihapus. Dua toggle
//      tersisa (DeepThink dan Search) aktif secara DEFAULT ON di situs. Kontrol
//      eksplisit disediakan via `deep_think` dan `web_search` (boolean) atau
//      `think_mode` baru ('auto', 'instant'/'fast', 'thinking', 'search', 'research').
//      `model_tab` sudah usang dan diabaikan. Attachment gambar/file diterima
//      langsung via field `attachments` (clipboard paste).
//   6. `x_meta.mode_fallback: true` menandakan sesi browser DeepSeek hilang
//      di server dan diam-diam mulai percakapan baru — kita respons
//      aktif: trigger memoryService.summarizeAndRemember() di background
//      agar konteks yang sempat ada tidak hilang percuma (lihat sendRequest).
//   7. Client API Token Authentication (§3): Setiap endpoint REST API kini wajib
//      menyertakan header `Authorization: Bearer <API_TOKEN>`. Dikonfigurasi
//      lewat PAF_API_TOKEN atau AI_API_KEY di .env.
// ─────────────────────────────────────────────────────────────────────────
import axios from 'axios';
import config from '../config/config.js';
import { sessionStore } from './sessionStore.js';
import { extractToolCall } from '../utils/toolCalling.js';
import { getPreciseTimeString } from './contextEnricher.js';
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

// Pasang Bearer token otomatis di setiap request jika API token dikonfigurasi
client.interceptors.request.use((reqConfig) => {
  const token = config.ai.apiKey || process.env.PAF_API_TOKEN || process.env.AI_API_KEY;
  if (token && !reqConfig.headers['Authorization'] && !reqConfig.headers['authorization']) {
    reqConfig.headers['Authorization'] = `Bearer ${token}`;
  }
  return reqConfig;
});

/**
 * Tentukan backend ("deepseek" | "qwen") dari string model.
 * Mendukung bentuk polos ("deepseek", "qwen") maupun ber-akun
 * ("deepseek(account1)", "qwen(account1.json)").
 *
 * @param {string} model
 * @returns {'deepseek'|'qwen'|'grok'}
 */
function resolveBackend(model) {
  if (model?.startsWith('qwen')) return 'qwen';
  if (model?.startsWith('grok')) return 'grok';
  return 'deepseek';
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
 * @param {string}   [options.thinkMode]        - "auto" | "instant" | "fast" | "thinking" | "search" | "research"
 * @param {boolean}  [options.deepThink]        - kontrol eksplisit DeepThink (DeepSeek)
 * @param {boolean}  [options.webSearch]        - kontrol eksplisit Web Search (DeepSeek)
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
  jid, userText, systemPrompt, forceNew = false, thinkMode, deepThink, webSearch,
  attachments, taskType, model, tools, memoryJid, useMemory = true,
}) {
  const resolvedModel = model || config.ai.chatModel;
  const backend = resolveBackend(resolvedModel);
  const isSpecialTask = taskType && taskType !== 'chat';

  // task_type khusus selalu session baru — tidak pakai X-Session-ID
  const existingSessionId = (forceNew || isSpecialTask) ? null : sessionStore.get(jid);
  const isFirstMessage = !existingSessionId;

  const headers = {};
  let messages = [];

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

  // System prompt terpadu (Unified System Prompt): Semua backend (DeepSeek,
  // Qwen, Grok) kini membaca role "system" dari array messages.
  // PAF-Model menyuntikkannya ke [SYSTEM CONTEXT] pada SETIAP turn dan TIDAK
  // menyimpannya di session server, sehingga WAJIB dikirim ulang di setiap request.
  if (normalizedPrompt) {
    messages.push({ role: 'system', content: normalizedPrompt });
  }
  messages.push({ role: 'user', content: userText });

  if (isFirstMessage) {
    logger.info({ jid, backend, taskType: taskType || 'chat' }, '🆕 Pesan pertama: session baru dibuat');
  } else {
    headers['X-Session-ID'] = existingSessionId;
    logger.debug({ jid, backend, sessionId: existingSessionId.slice(0, 8) + '...' }, '🔄 Continue mode: session ID + user message');
  }

  const body = {
    model: resolvedModel,
    messages,
    stream: false,
  };

  // task_type — hanya berlaku untuk backend qwen (diabaikan gateway untuk deepseek/grok)
  if (taskType && taskType !== 'chat') {
    body.task_type = taskType;
    logger.info({ jid, taskType }, '🎯 Request dengan task_type khusus');
  }

  // think_mode — opsional, arti beda per backend (lihat API_USAGE.md).
  // ⚠️ Keputusan produk:
  //   - Qwen: task berat (task khusus, attachment, tools) dipaksa 'thinking'
  //   - Chat session / non-heavy di Qwen default 'fast' (bukan 'auto') agar respons instan & tidak bertele-tele
  //   - DeepSeek: selalu menggunakan mode 'auto' untuk semua request yang menggunakan backend DeepSeek
  //   - Grok: think_mode tidak didukung di API — diabaikan / jangan dikirim
  const hasAttachments = Array.isArray(attachments) && attachments.length > 0;
  const hasTools = Array.isArray(tools) && tools.length > 0;
  let resolvedThinkMode;
  if (backend === 'qwen') {
    const isHeavyTask = isSpecialTask || hasAttachments || hasTools;
    resolvedThinkMode = isHeavyTask ? 'thinking' : (thinkMode || 'fast');
  } else if (backend === 'deepseek') {
    resolvedThinkMode = 'auto';
  } else {
    resolvedThinkMode = thinkMode;
  }
  if (backend !== 'grok' && resolvedThinkMode) {
    body.think_mode = resolvedThinkMode;
  }

  // Kontrol eksplisit DeepThink & Web Search (DeepSeek UI Baru)
  if (typeof deepThink === 'boolean') {
    body.deep_think = deepThink;
  }
  if (typeof webSearch === 'boolean') {
    body.web_search = webSearch;
  }

  // attachments — opsional, array of { filename, data (base64), mime_type? }
  // Didukung oleh Qwen dan DeepSeek secara native tanpa perlu model_tab usang
  if (Array.isArray(attachments) && attachments.length > 0) {
    body.attachments = attachments;
    logger.debug({ jid, attachmentCount: attachments.length }, '📎 Request dengan attachment');
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
 *   - `model` diisi eksplisit      → pakai itu
 *   - Ada attachments (gambar)     → 'qwen' (vision) — hardcoded, kemampuan
 *     vision eksklusif Qwen terlepas dari config
 *   - Tidak ada attachments/model  → config.ai.chatModel (kini Qwen)
 *
 * @param {object} options
 * @param {string}  options.jid
 * @param {string}  options.userText
 * @param {string}  [options.systemPrompt]
 * @param {string}  [options.thinkMode]      - "auto" | "instant" | "fast" | "thinking" | "search" | "research"
 * @param {boolean} [options.deepThink]      - kontrol eksplisit DeepThink
 * @param {boolean} [options.webSearch]      - kontrol eksplisit Web Search
 * @param {Array}   [options.attachments]    - [{ filename, data (base64), mime_type? }]
 * @param {string}  [options.model]          - override eksplisit "deepseek" | "qwen" | "<backend>(<account>)"
 * @param {string}  [options.memoryJid]      - jid asli untuk lookup memori, jika berbeda dari `jid`
 * @param {boolean} [options.useMemory=true] - injeksi memori jangka panjang pada pesan pertama sesi
 * @param {boolean} [options.forceNew=false]
 * @returns {Promise<string>} teks balasan AI
 */
export async function askAI({ jid, userText, systemPrompt, thinkMode, deepThink, webSearch, attachments, model: modelOverride, memoryJid, useMemory, forceNew }) {
  const hasImage = Array.isArray(attachments) && attachments.length > 0;
  // Gambar didukung oleh Qwen dan DeepSeek secara native.
  // Jika model saat ini adalah Grok (belum mendukung attachment di UI-nya), fallback ke Qwen.
  let model = modelOverride || config.ai.chatModel;
  if (hasImage && model.startsWith('grok')) {
    model = 'qwen';
  }

  try {
    const { text } = await sendRequest({ jid, userText, systemPrompt, thinkMode, deepThink, webSearch, attachments, taskType: 'chat', model, memoryJid, useMemory, forceNew });
    return text;
  } catch (err) {
    const status = err.response?.status;
    const detail = err.response?.data?.detail || err.message;
    logger.error({ jid, status, detail }, 'AI API error');

    if (status === 504) return '⏱️ Tidak ada worker AI tersedia saat ini, coba lagi sebentar.';
    if (status === 503) return '⚠️ Server AI belum mengonfigurasi API token (503). Hubungi admin VPS.';
    if (status === 502) return '⚠️ AI (Qwen) gagal merespons, coba lagi.';
    if (status === 500) return '⚠️ Terjadi kesalahan di server AI, coba lagi.';
    if (status === 429) return '⏳ AI sedang kena rate limit, coba lagi beberapa saat.';
    if (status === 401) {
      const isApiTokenError =
        err.response?.headers?.['www-authenticate']?.toLowerCase().includes('bearer') ||
        (typeof detail === 'string' && detail.toLowerCase().includes('api token'));
      if (isApiTokenError) {
        return '🔐 API Token bot tidak valid atau belum diisi (cek PAF_API_TOKEN di .env).';
      }
      return '🔐 Sesi AI tidak valid (perlu login ulang di worker), coba lagi nanti.';
    }
    if (status === 404) {
      sessionStore.delete(jid);
      return '🔄 Sesi AI tidak ditemukan (sesi di-reset), coba kirim pesanmu sekali lagi.';
    }
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
 * @param {boolean}  [options.deepThink]
 * @param {boolean}  [options.webSearch=false] - default false untuk task background agar bebas latency search
 * @returns {Promise<{ name: string|null, args: object, raw: string|null }>}
 */
export async function askAITool({ jid, userText, systemPrompt, tools, model, forceNew = true, memoryJid, useMemory = false, thinkMode, deepThink, webSearch }) {
  const resolvedModel = model || config.ai.taskModel;
  // Task background default webSearch: false agar tidak memicu web search yang tidak diinginkan
  const resolvedWebSearch = typeof webSearch === 'boolean' ? webSearch : false;

  try {
    const { text, toolCall } = await sendRequest({
      jid, userText, systemPrompt, thinkMode, taskType: 'chat',
      model: resolvedModel, forceNew, memoryJid, useMemory, tools,
      deepThink, webSearch: resolvedWebSearch,
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

// ─── Raw-JSON output (Legacy / Fallback) ───

/**
 * Parser tahan banting untuk output JSON dari model: buang code fence
 * ```json, ambil blok {...} terluar (first "{" .. last "}"), lalu JSON.parse.
 * Return null jika tidak ada JSON valid yang bisa diekstrak.
 *
 * @param {string} raw
 * @returns {object|null}
 */
function extractJsonBlock(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const cleaned = raw.replace(/```(?:json)?/gi, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return null;
  }
}

/**
 * [Deprecated / Fallback] Minta model membalas HANYA satu objek JSON valid lalu parse
 * hasilnya di sisi client.
 * Catatan: Sejak revisi API_USAGE.md §9, Grok dan seluruh backend kini sudah
 * mendukung tool/function-calling resmi (askAITool) via scrapers/tool_protocol.py.
 * Fungsi ini dipertahankan sebagai legacy fallback saja.
 *
 * @param {object} options
 * @param {string}  options.jid            - id untuk logging/session namespace
 * @param {string}  options.userText       - instruksi utama
 * @param {string}  [options.systemPrompt] - instruksi konten & skema JSON
 * @param {string}  [options.model]        - default config.ai.newsModel ('grok')
 * @param {number}  [options.maxAttempts]  - default 2
 * @returns {Promise<object|null>} objek hasil parse, atau null jika semua percobaan gagal
 */
export async function askAIJson({ jid, userText, systemPrompt, model, maxAttempts = 2 }) {
  const resolvedModel = model || config.ai.newsModel || 'grok';

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const formatWarning = attempt > 1
        ? '\n\nPERINGATAN FORMAT: balasanmu sebelumnya bukan JSON valid. Balas HANYA satu objek JSON valid — tanpa code fence, tanpa teks pembuka/penutup, tanpa komentar. Mulai dari { dan akhiri dengan }.'
        : '';
      const { text } = await sendRequest({
        jid: `${jid}_json_${Date.now()}`,
        userText: userText + formatWarning,
        systemPrompt,
        forceNew: true,
        taskType: 'chat',
        model: resolvedModel,
        useMemory: false,
      });

      const parsed = extractJsonBlock(text);
      if (parsed) return parsed;

      logger.warn({ jid, attempt, model: resolvedModel, preview: text?.slice(0, 120) }, '⚠️ askAIJson: output bukan JSON valid');
    } catch (err) {
      logger.warn({ jid, attempt, model: resolvedModel, err: err.message }, '⚠️ askAIJson: request gagal');
    }
  }

  logger.error({ jid, model: resolvedModel }, `❌ askAIJson: ${maxAttempts}x percobaan gagal menghasilkan JSON valid`);
  return null;
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
 * @param {string}  [options.accountModel] - override "qwen(accountX.json)", default 'qwen' (hardcoded)
 * @returns {Promise<{ text: string|null, urls: string[] }>}
 */
export async function generateImage({ jid, prompt, accountModel }) {
  try {
    const model = accountModel || 'qwen'; // media generation & web search selalu Qwen (task_type Qwen-only)
    logger.info({ jid, prompt: prompt.slice(0, 60) }, '🖼️ Request generate gambar...');

    const res = await client.post(
      '/v1/chat/completions',
      {
        model,
        task_type: 'create_image',
        messages: [{ role: 'user', content: prompt }],
        stream: false,
        think_mode: 'thinking', // task_type create_image selalu backend Qwen — dipaksa thinking
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
 * @param {string}  [options.accountModel] - override "qwen(accountX.json)", default 'qwen' (hardcoded)
 * @returns {Promise<{ text: string|null, urls: string[] }>}
 */
export async function generateVideo({ jid, prompt, accountModel }) {
  try {
    const model = accountModel || 'qwen'; // media generation & web search selalu Qwen (task_type Qwen-only)
    logger.info({ jid, prompt: prompt.slice(0, 60) }, '🎬 Request generate video...');

    const res = await client.post(
      '/v1/chat/completions',
      {
        model,
        task_type: 'create_video',
        messages: [{ role: 'user', content: prompt }],
        stream: false,
        think_mode: 'thinking', // task_type create_video selalu backend Qwen — dipaksa thinking
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
 * @param {string}  [options.accountModel] - override "qwen(accountX.json)", default 'qwen' (hardcoded)
 * @returns {Promise<string>} hasil pencarian sebagai teks
 */
export async function webSearch({ jid, query, accountModel }) {
  try {
    const model = accountModel || 'qwen'; // media generation & web search selalu Qwen (task_type Qwen-only)
    logger.info({ jid, query: query.slice(0, 60) }, '🔍 Request web search...');

    const res = await client.post(
      '/v1/chat/completions',
      {
        model,
        task_type: 'web_search',
        messages: [{ role: 'user', content: query }],
        stream: false,
        think_mode: 'thinking', // task_type web_search selalu backend Qwen — dipaksa thinking
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
 * @returns {Promise<string[]>} array id model, misal ['deepseek', 'qwen', 'grok', 'deepseek(account1)']
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
      model: 'qwen', // vision & pemahaman dokumen selalu Qwen — taskModel kini DeepSeek
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

/**
 * [Fitur 1 · Baca & Pahami Isi File] Ringkas isi sebuah dokumen (PDF, DOCX,
 * PPTX, dll) menggunakan Qwen. Mengikuti pola describeImage() di atas —
 * Opsi B (lihat rencana-fitur-baru-PAF-WhatsAppAgent.md): dokumen dikirim
 * UTUH sebagai attachment base64, TIDAK ADA ekstraksi teks lokal (tanpa
 * pdf-parse/mammoth/dll) — sepenuhnya diandalkan pada kemampuan Qwen
 * membaca file mentah (backend browser-automation, UI aslinya mendukung
 * upload dokumen).
 *
 * Menggunakan session terpisah (forceNew) agar tidak mencemari session chat
 * user/owner. Hasil ringkasan disimpan ke chatHistory oleh caller
 * (recordDocumentToHistory di core/messageHandler.js).
 *
 * @param {object} options
 * @param {string}  options.jid         - JID pengirim (untuk logging)
 * @param {Array}   options.attachments - [{ filename, data (base64), mime_type }]
 * @param {string}  [options.caption]   - caption/keterangan dokumen jika ada (opsional)
 * @returns {Promise<string|null>} ringkasan dokumen dalam bahasa Indonesia, atau null jika gagal
 */
export async function describeDocument({ jid, attachments, caption }) {
  const captionNote = caption?.trim()
    ? `Keterangan dari pengirim: "${caption.trim()}"\n\n`
    : '';

  const prompt = `${captionNote}Baca dan pahami isi dokumen ini secara menyeluruh. Berikan ringkasan yang mencakup:
- Topik atau inti utama dokumen
- Poin-poin penting atau temuan kunci di dalamnya
- Informasi relevan lain yang perlu diketahui

Tulis ringkasan dalam Bahasa Indonesia, padat dan informatif (3-6 kalimat sesuai kompleksitas dokumen).`;

  try {
    logger.info({ jid, hasCaption: !!caption }, '📄 Meringkas dokumen dengan Qwen...');

    // Sama seperti describeImage: session terpisah + forceNew, useMemory:
    // false karena ini task ringkasan satu kali, bukan chat.
    const { text } = await sendRequest({
      jid: `doc_desc_${jid}_${Date.now()}`,
      userText: prompt,
      attachments,
      forceNew: true,
      taskType: 'chat',
      model: 'qwen', // vision & pemahaman dokumen selalu Qwen — taskModel kini DeepSeek
      useMemory: false,
    });

    logger.info({ jid }, '✅ Ringkasan dokumen selesai');
    return text;
  } catch (err) {
    const status = err.response?.status;
    const detail = err.response?.data || err.message;
    logger.error({ jid, status, detail }, '❌ Gagal meringkas dokumen');
    return null;
  }
}

/**
 * [Fitur 3 · Konteks dari URL Instagram/TikTok] Ringkas konten sebuah video
 * (visual + audio) hasil download socialMediaService menggunakan Qwen.
 * Mengikuti pola describeImage()/describeDocument() — Opsi B: video
 * dikirim mentah sebagai attachment, TIDAK ADA transcribe lokal (Whisper)
 * atau extract-frame lokal (ffmpeg).
 *
 * @param {object} options
 * @param {string}  options.jid         - JID pengirim (untuk logging)
 * @param {Array}   options.attachments - [{ filename, data (base64), mime_type }] (1 video)
 * @param {string}  [options.caption]   - judul/deskripsi asli dari yt-dlp metadata (opsional)
 * @returns {Promise<string|null>} ringkasan video dalam bahasa Indonesia, atau null jika gagal
 */
export async function describeSocialMedia({ jid, attachments, caption }) {
  const captionNote = caption?.trim()
    ? `Judul/deskripsi asli konten: "${caption.trim()}"\n\n`
    : '';

  const prompt = `${captionNote}Tonton dan pahami video ini (visual dan audio/narasinya). Berikan ringkasan singkat yang mencakup:
- Isi/konten utama video
- Poin penting yang disampaikan (jika ada narasi/dialog)
- Konteks atau suasana keseluruhan

Tulis ringkasan dalam Bahasa Indonesia, padat dan informatif (2-4 kalimat).`;

  try {
    logger.info({ jid }, '🎬 Meringkas video dari media sosial dengan Qwen...');

    const { text } = await sendRequest({
      jid: `social_desc_${jid}_${Date.now()}`,
      userText: prompt,
      attachments,
      forceNew: true,
      taskType: 'chat',
      model: 'qwen', // vision & pemahaman dokumen selalu Qwen — taskModel kini DeepSeek
      useMemory: false,
    });

    logger.info({ jid }, '✅ Ringkasan video selesai');
    return text;
  } catch (err) {
    const status = err.response?.status;
    const detail = err.response?.data || err.message;
    logger.error({ jid, status, detail }, '❌ Gagal meringkas video dari media sosial');
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
 * Di-export agar jalur yang SUDAH punya teks final (mis. pesan proaktif
 * botBrain) bisa memecah tanpa memanggil model lagi.
 *
 * @param {string} raw
 * @returns {{ text: string, delay: number }[]}
 */
export function parseSegments(raw) {
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
 * [Fitur 4 · Bot Memahami Waktu] Blok ini SELALU menyertakan tanggal & jam
 * presisi WIB (getPreciseTimeString(), lihat contextEnricher.js) terlepas
 * dari ada/tidaknya contextHints — karena semua chat/interaksi natural
 * (askAISegmented) melewati fungsi ini, ini otomatis mencakup jalur chat
 * utama DAN pesan proaktif/follow-up botBrain (yang juga memanggil
 * askAISegmented) tanpa perlu perubahan terpisah di botBrain.js.
 *
 * @param {object} [contextHints]
 * @param {number} [contextHints.userMessageLength]   - panjang teks pesan user saat ini
 * @param {number} [contextHints.secondsSinceLastMessage] - jeda sejak pesan terakhir di history
 * @param {number} [contextHints.messagesLastFiveMin]  - jumlah pesan (user+bot) dalam 5 menit terakhir
 * @returns {string} blok teks (minimal berisi baris waktu presisi)
 */
function buildContextHintsBlock(contextHints) {
  const lines = ['=== SINYAL KONTEKS ==='];

  // Fitur 4: konteks waktu presisi — selalu disertakan, bukan opsional
  lines.push(`Tanggal & jam sekarang: ${getPreciseTimeString()}`);

  if (contextHints) {
    if (typeof contextHints.userMessageLength === 'number') {
      lines.push(`Panjang pesan user saat ini: ${contextHints.userMessageLength} karakter`);
    }
    if (typeof contextHints.secondsSinceLastMessage === 'number') {
      const mins = Math.round(contextHints.secondsSinceLastMessage / 60);
      lines.push(`Jeda sejak pesan terakhir di percakapan ini: ${mins < 1 ? '<1 menit' : `${mins} menit`}`);
    }
    if (typeof contextHints.messagesLastFiveMin === 'number') {
      lines.push(`Jumlah pesan (user+bot) dalam 5 menit terakhir: ${contextHints.messagesLastFiveMin} (${contextHints.messagesLastFiveMin >= 4 ? 'chat cepat/beruntun' : 'chat normal/santai'})`);
    }
  }

  return lines.join('\n');
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
 * @param {boolean} [options.deepThink]
 * @param {boolean} [options.webSearch]
 * @param {Array}   [options.attachments]
 * @param {string}  [options.model]         - override eksplisit "deepseek" | "qwen" | "<backend>(<account>)"
 * @param {string}  [options.memoryJid]     - jid asli untuk lookup memori, jika berbeda dari `jid`
 * @param {boolean} [options.useMemory=true]
 * @param {object}  [options.contextHints]  - lihat buildContextHintsBlock() — Fix #2: bantu AI memutuskan segmentasi
 * @returns {Promise<{ text: string, delay: number }[]>}
 */
export async function askAISegmented({ jid, userText, systemPrompt, thinkMode, deepThink, webSearch, attachments, model: modelOverride, memoryJid, useMemory, contextHints }) {
  const hasImage = Array.isArray(attachments) && attachments.length > 0;
  // Gambar didukung oleh Qwen dan DeepSeek secara native.
  // Jika model saat ini adalah Grok (belum mendukung attachment di UI-nya), fallback ke Qwen.
  let model = modelOverride || config.ai.chatModel;
  if (hasImage && model.startsWith('grok')) {
    model = 'qwen';
  }

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
      const defaultThinkMode = model.startsWith('qwen') ? 'fast' : 'auto';
      const { text } = await sendRequest({
        jid,
        userText,
        systemPrompt: wrappedSystemPrompt,
        thinkMode: thinkMode || defaultThinkMode,
        deepThink,
        webSearch,
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
      if (status === 404) {
        sessionStore.delete(jid);
      }
      logger.warn({ jid, attempt, err: err.message, status }, `⚠️ askAISegmented: error saat request (attempt ${attempt}/${MAX_NETWORK_RETRY})`);
    }
  }

  // Semua percobaan gagal karena error request/koneksi asli (bukan format)
  logger.error({ jid }, `❌ askAISegmented: ${MAX_NETWORK_RETRY}x percobaan gagal karena error koneksi/request`);
  return [{ text: '❌ Maaf, terjadi kesalahan. Coba lagi nanti.', delay: 0 }];
}

/**
 * Helper internal: Sinkronkan session ID owner ke kedua bentuk JID
 * (LID dan @s.whatsapp.net) agar pesan masuk via format manapun
 * langsung menggunakan session yang sama tanpa delay pembuatan sesi baru.
 *
 * @param {string} primaryJid
 * @param {string} sessionId
 */
function syncOwnerJidSessions(primaryJid, sessionId) {
  if (!sessionId) return;
  if (config.ownerJid && config.ownerJid !== primaryJid) {
    sessionStore.set(config.ownerJid, sessionId);
  }
  if (config.ownerLid && config.ownerLid !== primaryJid) {
    sessionStore.set(config.ownerLid, sessionId);
  }
}

/**
 * Inisialisasi chat session untuk owner saat bot start (bukan saat pesan pertama).
 *
 * Skenario:
 *   1. Ambil JID owner (prioritas LID jika tersedia, fallback @s.whatsapp.net).
 *   2. Cek apakah session sudah ada di sessionStore (misal dimuat dari DB).
 *      Jika sudah ada, gunakan dan sinkronkan ke LID dan @s.whatsapp.net.
 *   3. Jika belum ada, kirim pesan inisialisasi awal ke server dengan persona
 *      owner + injeksi memori jangka panjang (useMemory: true).
 *   4. Session ID yang dikembalikan server otomatis tersimpan di sessionStore
 *      (dan di-persist ke DB).
 *   5. Sinkronkan ke config.ownerJid dan config.ownerLid.
 *   Hasil: Saat owner mengirim pesan pertama, bot sudah dalam mode "continue"
 *   sehingga respons instan dan tidak ada jeda inisialisasi sesi di pesan pertama.
 *
 * @param {boolean} [force=false] - Jika true, paksa buat sesi baru meski sudah ada
 * @returns {Promise<string|null>} sessionId atau null jika gagal
 */
export async function initOwnerChatSession(force = false) {
  const ownerJid = config.ownerLid || config.ownerJid;
  if (!ownerJid) {
    logger.warn('Owner JID belum diset, skip init chat session');
    return null;
  }

  // Jika session sudah ada di sessionStore (misal dari DB) dan tidak force
  const existingSessionId = sessionStore.get(ownerJid);
  if (existingSessionId && !force) {
    logger.info(
      { ownerJid, sessionId: existingSessionId.slice(0, 8) + '...' },
      '⚡ Owner chat session sudah ada (dimuat dari DB), siap digunakan'
    );
    syncOwnerJidSessions(ownerJid, existingSessionId);
    return existingSessionId;
  }

  try {
    logger.info({ ownerJid }, '💬 Menginisialisasi owner chat session saat bot start...');

    const { getPersona } = await import('./personaService.js');
    const { prompt: systemPrompt } = getPersona(ownerJid, true);

    await sendRequest({
      jid: ownerJid,
      userText: 'Halo! Siap mengobrol.',
      systemPrompt,
      forceNew: true,
      taskType: 'chat',
      model: config.ai.chatModel,
      useMemory: true, // Injeksi memori jangka panjang ke system prompt sesi baru
    });

    const sessionId = sessionStore.get(ownerJid);
    if (sessionId) {
      syncOwnerJidSessions(ownerJid, sessionId);
      logger.info(
        { ownerJid, sessionId: sessionId.slice(0, 8) + '...' },
        '✅ Owner chat session berhasil diinisialisasi dan siap digunakan'
      );
    }
    return sessionId;
  } catch (err) {
    logger.warn(
      { ownerJid, err: err.message },
      '⚠️ Gagal inisialisasi owner chat session saat start (akan fallback saat pesan pertama)'
    );
    return null;
  }
}

/**
 * Backward compatibility: alias untuk initOwnerChatSession
 */
export async function warmupOwnerSession(ownerJid, systemPrompt) {
  return initOwnerChatSession();
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