// core/triggeredPluginHandler.js
// Infrastruktur triggered plugin — aktif hanya untuk owner/user pada pesan non-command.
//
// Alur:
//   1. Kirim teks ke intent session sender (session persisten di Qwen, bukan one-shot)
//   2. Qwen punya akses ke `tools` (function-calling, §9 API_USAGE.md) — satu
//      tool per triggered plugin → Qwen MEMANGGIL tool yang sesuai jika ada
//      aksi nyata (tidak lagi menulis raw JSON bebas yang rawan gagal parse)
//   3. intent (= nama tool yang dipanggil) dikenal → jalankan triggered plugin handler
//   4. Reply dari plugin di-intercept → dikirim ke chat session sebagai konteks sistem
//      agar chat session punya pemahaman yang sama dengan hasil eksekusi plugin
//      → tidak ada missed context antara intent session dan chat session
//   5. tidak ada tool dipanggil → tidak ada task (bot hanya kirim balasan chat session)
//
// [Paralel] Deteksi (detectTriggeredIntent) & eksekusi (executeTriggeredPlugin)
// dipisah. messageHandler menjalankan intent session & chat session BERSAMAAN,
// lalu memutuskan: tanpa task → kirim chat saja; ada task → kirim chat, lalu
// jalankan task.
//
// Setiap triggered plugin wajib export:
//   intent: string             — nama intent yang ditangani (jadi nama function/tool)
//   intentDefinition: string   — deskripsi intent (jadi description function/tool)
//   parameters: object         — (opsional, SANGAT disarankan) JSON Schema untuk
//                                 parameter tool ini, format OpenAI function-calling:
//                                 { type: 'object', properties: {...}, required: [...] }
//                                 Jika tidak diisi, fallback ke schema generik
//                                 (bebas properti apapun) — kurang presisi, AI lebih
//                                 mudah salah isi parameter. Lihat plugins/triggered/*.js
//                                 untuk contoh.
//   groupContextPrompt: string — persona grup otomatis saat plugin di-assign sebagai input/both
//   handler: async (ctx) => void

import { readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { detectIntentWithSession } from '../services/intentSessionService.js';
import { askAI } from '../services/aiService.js';
import { reportToChatSession } from '../services/sessionQueueService.js';
import { buildFunctionTool } from '../utils/toolCalling.js';
import logger from '../utils/logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Load semua triggered plugin dari plugins/triggered/ ──────────────────
const triggeredPlugins = new Map(); // intent → plugin

async function loadTriggeredPlugins() {
  const dir = join(__dirname, '..', 'plugins', 'triggered');
  let files;
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.js') && !f.startsWith('_'));
  } catch {
    logger.warn('Folder plugins/triggered tidak ditemukan atau kosong');
    return;
  }

  for (const file of files) {
    try {
      const mod = await import(pathToFileURL(join(dir, file)).href);
      const plugin = mod.default;

      if (!plugin?.intent || !plugin?.handler) {
        logger.warn({ file }, 'Triggered plugin tidak valid (butuh intent + handler), dilewati');
        continue;
      }

      if (!plugin.intentDefinition) {
        logger.warn({ file, intent: plugin.intent }, '⚠️ Plugin tidak punya intentDefinition — tidak akan masuk system prompt Qwen');
      }

      triggeredPlugins.set(plugin.intent.toLowerCase(), plugin);
      logger.info({ file, intent: plugin.intent }, '⚡ Triggered plugin loaded');
    } catch (err) {
      logger.error({ file, err: err.message }, 'Gagal load triggered plugin');
    }
  }
}

await loadTriggeredPlugins();

// ─── Lookup satu triggered plugin berdasarkan key (intent name) ───────────
/**
 * Ambil satu triggered plugin berdasarkan intent key.
 * Dipakai oleh groupService saat owner assign channel — untuk mengambil
 * groupContextPrompt dari plugin yang bersangkutan.
 *
 * @param {string} key - nama intent (case-insensitive)
 * @returns {object|null} plugin object atau null jika tidak ditemukan
 */
export function getTriggeredPluginByKey(key) {
  return triggeredPlugins.get(key.toLowerCase()) || null;
}

// ─── Expose intent definitions untuk intentSessionService ─────────────────
/**
 * Kumpulkan semua intentDefinition dari triggered plugins yang sudah di-load.
 * Dipanggil oleh intentSessionService saat build system prompt Qwen.
 *
 * @returns {{ intent: string, definition: string }[]}
 */
export function getIntentDefinitions() {
  const result = [];
  for (const [intent, plugin] of triggeredPlugins.entries()) {
    if (plugin.intentDefinition) {
      result.push({
        intent,
        definition: plugin.intentDefinition,
      });
    }
  }
  return result;
}

// Schema fallback generik — dipakai jika plugin belum mendefinisikan
// `parameters` sendiri. Menerima properti apapun (kurang presisi, tapi
// tetap backward-compat dengan plugin lama yang hanya punya intentDefinition
// dalam bentuk prosa).
const GENERIC_PARAMS_SCHEMA = {
  type: 'object',
  properties: {},
  additionalProperties: true,
};

// ─── Expose daftar tools (function-calling) untuk intentSessionService ──
/**
 * Bangun daftar `tools` (OpenAI function-calling shape, §9 API_USAGE.md)
 * dari semua triggered plugin yang sudah di-load — satu tool per plugin,
 * nama function = intent, description = intentDefinition, parameters =
 * plugin.parameters (atau schema generik jika plugin belum mendefinisikannya).
 *
 * Dipanggil oleh intentSessionService saat build request ke Qwen.
 *
 * @returns {object[]} array tool, lihat utils/toolCalling.js buildFunctionTool()
 */
export function getIntentToolSchemas() {
  const tools = [];
  for (const [intent, plugin] of triggeredPlugins.entries()) {
    const baseDefinition = plugin.intentDefinition || `Intent "${intent}" — tidak ada deskripsi.`;
    // ⚠️ Opsi 2 (lihat diskusi update AiService): untuk backend Qwen, HANYA teks
    // di dalam `tools[].function.description` yang dijamin masuk ke blok
    // [SYSTEM CONTEXT] berprioritas tinggi milik gateway (lihat _build_wrapped_prompt
    // di scrapers/qwen_scraper.py, repo FiePaw/PAF-Model) — systemPrompt bebas (BASE_PROMPT)
    // hanya nebeng di [USER REQUEST] dan cuma dikirim sekali saat initIntentSession().
    // Supaya aturan "panggil HANYA jika yakin" tidak hilang seiring sesi berjalan lama,
    // aturan itu diduplikasi di sini — diulang di SETIAP function description, dan
    // description ini di-resend di SETIAP pesan (lihat _sendToIntentSession()), bukan
    // hanya sekali di awal seperti BASE_PROMPT.
    const reinforcedDefinition =
      `${baseDefinition} (Panggil fungsi ini HANYA jika kriteria di atas terpenuhi dan ` +
      `informasi pada pesan owner sudah cukup untuk mengisi parameter wajib — jika ragu ` +
      `atau informasi kurang, JANGAN memanggil fungsi ini.)`;

    tools.push(
      buildFunctionTool(
        intent,
        reinforcedDefinition,
        plugin.parameters || GENERIC_PARAMS_SCHEMA
      )
    );
  }
  return tools;
}

// ─── Tahap 1: deteksi intent (TANPA eksekusi) ─────────────────────────────
/**
 * Kirim teks ke intent session dan kembalikan task yang terdeteksi, TANPA
 * menjalankan plugin. Dipakai messageHandler agar intent session & chat
 * session bisa berjalan PARALEL — bot yang memutuskan setelah keduanya
 * selesai (ada task atau tidak).
 *
 * @param {object} ctx - { sender, text, attachments? }
 * @returns {Promise<{ intent: string, params: object, plugin: object }|null>}
 *          null jika tidak ada task yang valid
 */
export async function detectTriggeredIntent(ctx) {
  const { sender, text, attachments } = ctx;

  logger.debug({ text: text.slice(0, 60), hasAttachment: !!attachments }, '🔍 Kirim ke intent session...');

  // Session key = sender (DM & grup tetap satu intent session per sender)
  const { intent, params } = await detectIntentWithSession(sender, text, attachments);

  if (!intent) {
    logger.debug({ sender: sender.split('@')[0] }, 'Intent null — tidak ada task');
    return null;
  }

  const plugin = triggeredPlugins.get(intent.toLowerCase());
  if (!plugin) {
    logger.warn({ intent }, 'Intent terdeteksi tapi tidak ada triggered plugin untuk menangani');
    return null;
  }

  // Model kadang memanggil tool tapi gagal ekstrak parameter (args {}).
  // Bukan sinyal yang bisa diandalkan → anggap tidak ada task.
  if (!params || Object.keys(params).length === 0) {
    logger.warn(
      { intent, sender: sender.split('@')[0] },
      '⚠️ Intent terdeteksi tapi params kosong total — dianggap tidak ada task'
    );
    return null;
  }

  return { intent, params, plugin };
}

// ─── Tahap 2: eksekusi task hasil deteksi ─────────────────────────────────
/**
 * Jalankan triggered plugin dari hasil detectTriggeredIntent(). Dipanggil
 * bot SETELAH balasan chat session terkirim. Reply plugin di-intercept dan
 * di-inject ke chat session sebagai konteks agar tidak ada missed context.
 *
 * @param {object} ctx - { sock, msg, jid, sender, isOwner, text, reply, attachments? }
 * @param {{ intent: string, params: object, plugin: object }} detected
 * @returns {Promise<void>}
 */
export async function executeTriggeredPlugin(ctx, detected) {
  const { jid, sender } = ctx;
  const { intent, params, plugin } = detected;

  logger.info({ intent, params, sender: sender.split('@')[0] }, '⚡ Triggered plugin dijalankan');

  let capturedReply = null;
  const interceptedReply = async (replyText) => {
    capturedReply = replyText;
    await ctx.reply(replyText);
  };

  try {
    await plugin.handler({ ...ctx, reply: interceptedReply, params });
  } catch (err) {
    logger.error({ intent, err: err.message }, 'Error di triggered plugin handler');
    await ctx.reply('⚠️ Gagal menjalankan aksi. Coba lagi atau cek log.');
    return;
  }

  // Inject hasil plugin ke chat session via sessionQueueService
  // (bukan langsung ke askAI) agar tidak bentrok dengan pesan user yang mungkin
  // sedang diproses di sesi yang sama (race condition di PAF-Model browser tab).
  if (capturedReply) {
    const systemContext = `[SYSTEM] Aksi intent "${intent}" telah dieksekusi. Hasilnya: ${capturedReply}`;
    reportToChatSession({
      jid,
      reportText: systemContext,
      source: `intent:${intent}`,
    }).catch((err) => {
      logger.warn({ intent, jid, err: err.message }, '⚠️ Gagal kirim hasil plugin ke sessionQueueService');
    });
    logger.debug({ intent, jid }, '📨 Hasil plugin diteruskan ke sessionQueueService');
  }
}

// ─── Wrapper sequential (backward-compat) ─────────────────────────────────
/**
 * Deteksi lalu langsung eksekusi (alur lama, sequential). Tidak lagi dipakai
 * messageHandler — dipertahankan untuk kompatibilitas.
 *
 * @returns {Promise<boolean>} true jika task dijalankan
 */
export async function handleTriggeredPlugin(ctx) {
  const detected = await detectTriggeredIntent(ctx);
  if (!detected) return false;
  await executeTriggeredPlugin(ctx, detected);
  return true;
}