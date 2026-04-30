// core/triggeredPluginHandler.js
// Infrastruktur triggered plugin — aktif hanya untuk owner/user pada pesan non-command.
//
// Alur:
//   1. Kirim teks ke intent session sender (session persisten di Qwen, bukan one-shot)
//   2. Qwen punya konteks percakapan → return JSON { intent, params }
//   3. intent dikenal → jalankan triggered plugin → return true
//   4. intent null   → return false (fallback ke AI chat biasa)

import { readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { detectIntentWithSession } from '../services/intentSessionService.js';
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
        logger.warn({ file }, 'Triggered plugin tidak valid, dilewati');
        continue;
      }
      triggeredPlugins.set(plugin.intent.toLowerCase(), plugin);
      logger.info({ file, intent: plugin.intent }, '⚡ Triggered plugin loaded');
    } catch (err) {
      logger.error({ file, err: err.message }, 'Gagal load triggered plugin');
    }
  }
}

await loadTriggeredPlugins();

// ─── Main handler ─────────────────────────────────────────────────────────
/**
 * Coba jalankan triggered plugin berdasarkan intent dari session persisten sender.
 *
 * @param {object} ctx - { sock, msg, jid, sender, isOwner, text, reply }
 * @returns {Promise<boolean>} true jika triggered plugin dijalankan, false jika tidak ada intent
 */
export async function handleTriggeredPlugin(ctx) {
  const { sender, text } = ctx;

  logger.debug({ text: text.slice(0, 60) }, '🔍 Kirim ke intent session...');

  // Gunakan sender sebagai key session — bukan jid chat (agar DM dan grup tetap satu session per sender)
  const { intent, params } = await detectIntentWithSession(sender, text);

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

  try {
    await plugin.handler({ ...ctx, params });
    return true;
  } catch (err) {
    logger.error({ intent, err: err.message }, 'Error di triggered plugin handler');
    await ctx.reply('⚠️ Gagal menjalankan aksi. Coba lagi atau cek log.');
    return true;
  }
}