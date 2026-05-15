// core/triggeredPluginHandler.js
// Infrastruktur triggered plugin — aktif hanya untuk owner/user pada pesan non-command.
//
// Alur:
//   1. Kirim teks ke intent session sender (session persisten di Qwen, bukan one-shot)
//   2. Qwen punya konteks percakapan → return JSON { intent, params }
//   3. intent dikenal → jalankan triggered plugin handler
//   4. Reply dari plugin di-intercept → dikirim ke chat session sebagai konteks sistem
//      agar chat session punya pemahaman yang sama dengan hasil eksekusi plugin
//      → tidak ada missed context antara intent session dan chat session
//   5. intent null → return false (fallback ke AI chat biasa)
//
// Setiap triggered plugin wajib export:
//   intent: string             — nama intent yang ditangani
//   intentDefinition: string   — deskripsi intent untuk system prompt Qwen
//   groupContextPrompt: string — persona grup otomatis saat plugin di-assign sebagai input/both
//   handler: async (ctx) => void

import { readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { detectIntentWithSession } from '../services/intentSessionService.js';
import { askAI } from '../services/aiService.js';
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

// ─── Main handler ─────────────────────────────────────────────────────────
/**
 * Coba jalankan triggered plugin berdasarkan intent dari session persisten sender.
 * Reply dari plugin di-intercept dan dikirim ke chat session sebagai konteks sistem
 * agar chat session memahami hasil eksekusi plugin — mencegah missed context.
 *
 * @param {object} ctx - { sock, msg, jid, sender, isOwner, text, reply, attachments? }
 * @returns {Promise<boolean>} true jika triggered plugin dijalankan, false jika tidak ada intent
 */
export async function handleTriggeredPlugin(ctx) {
  const { sender, jid, text, attachments } = ctx;

  logger.debug({ text: text.slice(0, 60), hasAttachment: !!attachments }, '🔍 Kirim ke intent session...');

  // Gunakan sender sebagai key session — bukan jid chat (agar DM dan grup tetap satu session per sender)
  // Teruskan attachments agar Qwen bisa analisis gambar untuk deteksi intent
  const { intent, params } = await detectIntentWithSession(sender, text, attachments);

  if (!intent) {
    logger.debug({ sender: sender.split('@')[0] }, 'Intent null — fallback ke AI chat');
    return false;
  }

  const plugin = triggeredPlugins.get(intent.toLowerCase());

  if (!plugin) {
    logger.warn({ intent }, 'Intent terdeteksi tapi tidak ada triggered plugin untuk menangani');
    return false;
  }

  logger.info({ intent, params, sender: sender.split('@')[0] }, '⚡ Triggered plugin dijalankan');

  // ── Intercept reply dari plugin ──────────────────────────────────────────
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
    return true;
  }

  // ── Inject hasil plugin ke chat session ─────────────────────────────────
  if (capturedReply) {
    const systemContext = `[SYSTEM] Aksi intent "${intent}" telah dieksekusi. Hasilnya: ${capturedReply}`;
    askAI({
      jid,
      userText: systemContext,
      systemPrompt: null,
    }).catch((err) => {
      logger.warn({ intent, jid, err: err.message }, '⚠️ Gagal inject hasil plugin ke chat session');
    });
    logger.debug({ intent, jid }, '📨 Hasil plugin di-inject ke chat session');
  }

  return true;
}