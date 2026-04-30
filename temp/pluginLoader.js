// core/pluginLoader.js
import { readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import logger from '../utils/logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Load semua plugin dari folder /plugins
 * Setiap plugin harus export default object dengan shape:
 * {
 *   name: string,          // nama plugin
 *   description: string,   // deskripsi singkat
 *   commands: string[],    // list command yang di-handle (tanpa prefix)
 *   ownerOnly: boolean,    // jika true, hanya owner yang bisa pakai
 *   handler: async (ctx) => void  // fungsi handler
 * }
 *
 * ctx = { sock, msg, jid, sender, isOwner, text, command, args, fullArgs, reply }
 */
export async function loadPlugins() {
  const pluginsDir = join(__dirname, '..', 'plugins');
  const files = readdirSync(pluginsDir).filter(
    (f) => f.endsWith('.js') && !f.startsWith('_')
  );

  const plugins = new Map(); // command -> plugin

  for (const file of files) {
    try {
      const filePath = pathToFileURL(join(pluginsDir, file)).href;
      const mod = await import(filePath);
      const plugin = mod.default;

      if (!plugin || !plugin.commands || !plugin.handler) {
        logger.warn({ file }, 'Plugin tidak valid, dilewati');
        continue;
      }

      for (const cmd of plugin.commands) {
        plugins.set(cmd.toLowerCase(), plugin);
      }

      logger.info({ file, commands: plugin.commands }, '✅ Plugin loaded');
    } catch (err) {
      logger.error({ file, err: err.message }, '❌ Gagal load plugin');
    }
  }

  logger.info({ total: plugins.size }, `Total ${plugins.size} command terdaftar`);
  return plugins;
}
