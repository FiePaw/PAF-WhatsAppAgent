// core/scheduledPluginLoader.js
// Loader khusus untuk scheduled plugin — plugin yang berjalan otomatis
// berdasarkan jadwal (cron) tanpa membutuhkan trigger dari pesan apapun.
//
// Scheduled plugin wajib export default object dengan shape:
// {
//   name: string,          // nama plugin (untuk log)
//   description: string,   // deskripsi singkat (untuk log dan debug)
//   crons: [
//     {
//       name: string,              // nama unik job (gunakan prefix "scheduled:")
//       expr: string,              // cron expression atau alias
//                                  // (@daily, @hourly, @every_4h, @every_30m, dll)
//       handler: async () => void, // fungsi yang dijalankan
//       runOnStart?: boolean,      // jalankan sekali langsung saat bot start (default: false)
//     }
//   ]
// }
//
// Scheduled plugin TIDAK memiliki command handler — tidak bisa dipanggil manual.
// Semua eksekusi dilakukan oleh cronService secara otomatis.

import { readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import cronService from '../services/cronService.js';
import logger from '../utils/logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Load semua scheduled plugin dari folder /plugins/scheduled/
 * Setiap plugin di-register ke cronService (autoStart: false).
 * cronService.startAll() dipanggil di bot.js setelah connection.open.
 */
export async function loadScheduledPlugins() {
  const scheduledDir = join(__dirname, '..', 'plugins', 'scheduled');
  let files;

  try {
    files = readdirSync(scheduledDir).filter(
      (f) => f.endsWith('.js') && !f.startsWith('_')
    );
  } catch {
    logger.warn('Folder plugins/scheduled tidak ditemukan atau kosong, skip');
    return;
  }

  let totalJobs = 0;

  for (const file of files) {
    try {
      const filePath = pathToFileURL(join(scheduledDir, file)).href;
      const mod = await import(filePath);
      const plugin = mod.default;

      // Validasi struktur plugin
      if (!plugin?.name || !plugin?.crons || !Array.isArray(plugin.crons)) {
        logger.warn({ file }, '⚠️ Scheduled plugin tidak valid (butuh name + crons[]), dilewati');
        continue;
      }

      if (plugin.crons.length === 0) {
        logger.warn({ file, name: plugin.name }, '⚠️ Scheduled plugin tidak punya cron job, dilewati');
        continue;
      }

      // Register semua cron job dari plugin
      for (const job of plugin.crons) {
        if (!job.name || !job.expr || !job.handler) {
          logger.warn({ file, job: job.name }, '⚠️ Definisi cron job tidak valid (butuh name, expr, handler), dilewati');
          continue;
        }

        cronService.register(job.name, job.expr, job.handler, {
          autoStart: false,                    // di-start oleh bot.js setelah connection.open
          runOnRegister: job.runOnStart || false,
        });

        totalJobs++;
      }

      logger.info(
        { file, name: plugin.name, jobs: plugin.crons.map((j) => j.name) },
        '📅 Scheduled plugin loaded'
      );
    } catch (err) {
      logger.error({ file, err: err.message }, '❌ Gagal load scheduled plugin');
    }
  }

  logger.info({ total: totalJobs }, `Total ${totalJobs} scheduled job terdaftar`);
}