// services/sessionQueueService.js
// Ephemeral Batch Consolidation & Chat Session Concurrency Lock
//
// Masalah yang diselesaikan:
//   1. Race condition — dua request HTTP dikirim ke X-Session-ID yang sama secara bersamaan
//      (misal: user chat + BotBrain report) → tab browser PAF-Model bentrok → 504/429.
//   2. Turn pollution — beberapa laporan sistem masuk berturut-turut ke sesi chat,
//      menghabiskan context window dan memicu latensi berlebih.
//
// Solusi:
//   - acquireSessionLock(jid) / releaseSessionLock(jid) — pasang di sekeliling runIntentAndChat
//     di messageHandler.js agar tidak ada task lain yang bisa masuk saat user chat aktif.
//   - reportToChatSession({ jid, reportText, source, systemPrompt }) — titik masuk tunggal
//     untuk semua laporan background (BotBrain, triggered plugin).
//     * Sesi IDLE  → langsung inject.
//     * Sesi BUSY  → tampung ke buffer; flush otomatis saat lock dilepas.
//   - Jika buffer berisi > 1 laporan → konsolidasi dulu via sesi sementara Qwen (forceNew)
//     lalu hapus sesi tersebut → hanya 1 turn yang masuk ke sesi utama.
//
// Batasan buffer: MAX_QUEUE_SIZE laporan per JID — jika terlampaui, flush paksa dilakukan
// agar tidak ada memory leak saat bot berjalan lama.

import { askAI, deleteRemoteSession } from './aiService.js';
import logger from '../utils/logger.js';

/** Batas maksimal laporan per JID dalam buffer sebelum flush paksa dipicu. */
const MAX_QUEUE_SIZE = 10;

/** Status sibuk per JID: Map<jid, boolean> */
const _sessionLocks = new Map();

/** Antrean laporan per JID: Map<jid, Array<{ text, source, timestamp }>> */
const _pendingQueues = new Map();

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Cek apakah sesi chat JID sedang memproses giliran pesan.
 * @param {string} jid
 * @returns {boolean}
 */
export function isSessionBusy(jid) {
  return _sessionLocks.get(jid) === true;
}

/**
 * Kunci status sesi chat sebelum memproses pesan user.
 * Dipanggil di messageHandler.js SEBELUM runIntentAndChat.
 * @param {string} jid
 */
export function acquireSessionLock(jid) {
  _sessionLocks.set(jid, true);
  logger.debug({ jid }, '🔒 sessionQueue: Sesi dikunci (BUSY)');
}

/**
 * Lepas kunci sesi chat setelah pesan user selesai diproses,
 * lalu otomatis flush antrean laporan yang tertampung (jika ada).
 * Dipanggil di messageHandler.js di blok finally setelah runIntentAndChat.
 * @param {string} jid
 */
export async function releaseSessionLock(jid) {
  _sessionLocks.set(jid, false);
  logger.debug({ jid }, '🔓 sessionQueue: Sesi dibuka (IDLE), memeriksa antrean...');
  await flushPendingReports(jid);
}

/**
 * Titik masuk utama untuk semua task yang ingin melaporkan konteks ke sesi chat utama.
 * Menggantikan pemanggilan langsung ke askAI() dari BotBrain & triggered plugin.
 *
 *   - Sesi IDLE  → inject langsung ke sesi utama.
 *   - Sesi BUSY  → tampung ke buffer; akan di-flush otomatis saat releaseSessionLock dipanggil.
 *
 * Jika buffer sudah mencapai MAX_QUEUE_SIZE, flush paksa dipicu agar memory tidak bocor.
 *
 * @param {object} params
 * @param {string} params.jid          - JID sesi chat utama yang menjadi target
 * @param {string} params.reportText   - Teks laporan / konteks yang akan diinjeksi
 * @param {string} [params.source]     - Label sumber laporan (untuk log & konsolidasi)
 * @param {string|null} [params.systemPrompt] - System prompt opsional saat inject langsung
 */
export async function reportToChatSession({ jid, reportText, source = 'system', systemPrompt = null }) {
  if (!reportText?.trim()) return;

  if (isSessionBusy(jid)) {
    // Sesi sedang sibuk → masukkan ke buffer
    if (!_pendingQueues.has(jid)) {
      _pendingQueues.set(jid, []);
    }
    const queue = _pendingQueues.get(jid);
    queue.push({ text: reportText.trim(), source, timestamp: Date.now() });
    logger.info({ jid, source, queueSize: queue.length }, '📥 sessionQueue: Laporan ditampung ke antrean');

    // Flush paksa jika buffer penuh (anti-memory-leak)
    if (queue.length >= MAX_QUEUE_SIZE) {
      logger.warn({ jid, queueSize: queue.length }, '⚠️ sessionQueue: Buffer penuh, memicu flush paksa');
      // Jalankan flush di background — tidak menunggu agar reportToChatSession tetap non-blocking
      flushPendingReports(jid).catch((err) =>
        logger.warn({ jid, err: err.message }, '⚠️ sessionQueue: Flush paksa gagal')
      );
    }
    return;
  }

  // Sesi idle → inject langsung
  await _sendDirectReport(jid, reportText, systemPrompt);
}

// ─── Private helpers ──────────────────────────────────────────────────────────

/**
 * Kirim 1 laporan langsung ke sesi chat utama via askAI.
 * @param {string} jid
 * @param {string} text
 * @param {string|null} systemPrompt
 */
async function _sendDirectReport(jid, text, systemPrompt = null) {
  try {
    await askAI({
      jid,
      userText: text,
      systemPrompt,
      thinkMode: 'fast',
    });
    logger.debug({ jid }, '✅ sessionQueue: Laporan berhasil diinjeksi ke sesi utama');
  } catch (err) {
    logger.warn({ jid, err: err.message }, '⚠️ sessionQueue: Gagal injeksi laporan ke sesi utama');
  }
}

/**
 * Proses dan kosongkan semua laporan yang tertampung di buffer untuk JID ini.
 * Dipanggil otomatis oleh releaseSessionLock, atau secara paksa jika buffer penuh.
 *
 * - 0 laporan  → tidak ada yang dilakukan.
 * - 1 laporan  → inject langsung tanpa konsolidasi.
 * - >1 laporan → konsolidasi via sesi Qwen sementara → inject 1 ringkasan ke sesi utama.
 *
 * Selama flush berjalan, sesi dikunci kembali untuk mencegah race dengan pesan user baru.
 * @param {string} jid
 */
async function flushPendingReports(jid) {
  const queue = _pendingQueues.get(jid) || [];
  if (queue.length === 0) return;

  // Ambil snapshot & bersihkan buffer sekarang (agar laporan baru yang masuk
  // selama proses flush tidak ikut terhapus secara tidak sengaja)
  const snapshot = [...queue];
  _pendingQueues.delete(jid);

  // Kunci kembali sementara agar pesan user baru yang muncul saat flush berjalan
  // tetap masuk ke buffer (bukan langsung inject dan menyebabkan race)
  _sessionLocks.set(jid, true);

  try {
    if (snapshot.length === 1) {
      // Hanya 1 laporan → langsung kirim tanpa konsolidasi
      logger.debug({ jid }, '📤 sessionQueue: Flush 1 laporan langsung ke sesi utama');
      await _sendDirectReport(jid, snapshot[0].text);
    } else {
      // Lebih dari 1 laporan → konsolidasi via sesi sementara
      logger.info({ jid, count: snapshot.length }, '⚡ sessionQueue: Mengonsolidasikan laporan via sesi sementara...');
      const consolidatedText = await _consolidateWithEphemeralSession(jid, snapshot);
      await _sendDirectReport(jid, consolidatedText);
    }
  } finally {
    // Pastikan lock selalu dilepas, bahkan jika flush gagal di tengah jalan
    _sessionLocks.set(jid, false);

    // Jika ada laporan baru yang masuk selama flush, rekursi sekali untuk memprosesnya
    const remaining = _pendingQueues.get(jid) || [];
    if (remaining.length > 0) {
      logger.debug({ jid, remaining: remaining.length }, '🔄 sessionQueue: Laporan baru masuk saat flush, memproses ulang...');
      flushPendingReports(jid).catch((err) =>
        logger.warn({ jid, err: err.message }, '⚠️ sessionQueue: Rekursi flush gagal')
      );
    }
  }
}

/**
 * Buat sesi sementara terisolasi di Qwen (forceNew: true) untuk merangkum
 * kumpulan laporan, lalu hapus sesi tersebut di server PAF-Model agar tidak
 * membebani tab browser worker.
 *
 * @param {string} jid - JID asli (hanya untuk log; sesi sementara pakai tempJid)
 * @param {Array<{ text: string, source: string, timestamp: number }>} reports
 * @returns {Promise<string>} Teks konsolidasi yang siap diinjeksi ke sesi utama
 */
async function _consolidateWithEphemeralSession(jid, reports) {
  const tempJid = `temp_consolidate_${jid}_${Date.now()}`;

  const reportList = reports
    .map((r, i) => `${i + 1}. [${r.source.toUpperCase()}] ${r.text}`)
    .join('\n');

  const consolidationPrompt =
    `Berikut adalah beberapa catatan laporan sistem internal yang terjadi bersamaan saat percakapan berlangsung:\n\n` +
    `${reportList}\n\n` +
    `Tugas: Satukan dan rangkum semua poin di atas menjadi SATU paragraf ringkasan konteks sistem yang padat, singkat, dan jelas (Bahasa Indonesia). ` +
    `Fokus pada status akhir dan aksi nyata. Jangan buat poin-poin panjang, jadikan satu narasi ringkas.`;

  try {
    const summary = await askAI({
      jid: tempJid,
      userText: consolidationPrompt,
      systemPrompt: 'Kamu adalah asisten internal pengonsolidasi log sistem. Buat ringkasan yang padat dan netral.',
      thinkMode: 'fast',
      forceNew: true,
      useMemory: false,
    });

    return (
      `[SISTEM - Rangkuman Pembaruan Terkonsolidasi]\n` +
      `${summary?.trim() || reportList}\n\n` +
      `[INSTRUKSI: Ini catatan pembaruan internal, balas HANYA dengan "noted" atau "ok".]`
    );
  } catch (err) {
    logger.warn({ jid, err: err.message }, '⚠️ sessionQueue: Gagal konsolidasi via sesi sementara, fallback gabung manual');
    // Fallback darurat: gabung semua laporan tanpa AI jika sesi sementara gagal
    return (
      `[SISTEM - Pembaruan Menumpuk]\n` +
      `${reports.map((r) => r.text).join('\n')}\n\n` +
      `[INSTRUKSI: Balas HANYA dengan "noted" atau "ok".]`
    );
  } finally {
    // Selalu bersihkan sesi sementara di server agar tidak menumpuk di browser worker VPS
    try {
      const { sessionStore } = await import('./sessionStore.js');
      const tempSessionId = sessionStore.get(tempJid);
      if (tempSessionId) {
        await deleteRemoteSession(tempSessionId);
        sessionStore.delete(tempJid);
        logger.debug({ jid, tempJid }, '🗑️ sessionQueue: Sesi sementara konsolidasi dihapus dari server');
      }
    } catch {
      // Abaikan error cleanup — sesi sementara yang tidak terhapus tidak kritis
    }
  }
}
