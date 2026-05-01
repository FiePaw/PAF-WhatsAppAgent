// core/pluginLoader.js
import { readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import cronService from '../services/cronService.js';
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
 *   handler: async (ctx) => void,  // fungsi handler
 *
 *   // OPTIONAL — untuk plugin yang butuh scheduler:
 *   crons?: [
 *     {
 *       name: string,        // nama unik job (global, gunakan prefix plugin)
 *       expr: string,        // cron expression atau alias (@daily, @every_60s, dll)
 *       handler: async () => void,  // fungsi yang dijalankan
 *       runOnRegister?: boolean,    // jalankan sekali langsung saat register
 *     }
 *   ]
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

      // Register command handlers
      for (const cmd of plugin.commands) {
        plugins.set(cmd.toLowerCase(), plugin);
      }

      // Register cron jobs dari plugin (jika ada)
      if (Array.isArray(plugin.crons)) {
        for (const job of plugin.crons) {
          if (!job.name || !job.expr || !job.handler) {
            logger.warn({ file, job: job.name }, '⚠️ Definisi cron job tidak valid, dilewati');
            continue;
          }
          cronService.register(job.name, job.expr, job.handler, {
            autoStart: false, // akan di-start di bot.js setelah connection.open
            runOnRegister: job.runOnRegister || false,
          });
        }
      }

      logger.info({ file, commands: plugin.commands }, '✅ Plugin loaded');
    } catch (err) {
      logger.error({ file, err: err.message }, '❌ Gagal load plugin');
    }
  }

  logger.info({ total: plugins.size }, `Total ${plugins.size} command terdaftar`);
  return plugins;
}