// services/sessionStore.js
// Persistent store untuk X-Session-ID dari API server per JID.
//
// Sebelumnya: pure in-memory Map → session hilang saat bot mati/reconnect,
// meski session di server AI masih aktif dan belum expired.
//
// Sekarang: dua lapis storage —
//   1. In-memory Map  → akses cepat saat bot berjalan
//   2. DB collection "aiSessions" → persist ke disk, survive restart
//
// Alur saat bot restart:
//   loadFromDb() → baca semua session dari DB → isi in-memory Map
//   → saat ada pesan masuk, session lama langsung dipakai (continue mode)
//   → session yang sudah expired saat dibaca otomatis dibersihkan
//
// Struktur dokumen di collection "aiSessions":
// {
//   jid:       string,      // identifier unik per JID
//   sessionId: string,      // X-Session-ID dari server AI
//   lastUsed:  ISO string,  // kapan terakhir digunakan
// }

import db from './db.js';
import config from '../config/config.js';
import logger from '../utils/logger.js';

const COLLECTION = 'aiSessions';

class SessionStore {
  constructor() {
    // In-memory cache — sumber kebenaran saat runtime
    this._store = new Map();
    this._ttl = config.sessionTtl;

    // Auto-cleanup setiap 10 menit (hapus expired dari memory + DB)
    setInterval(() => this._cleanup(), 10 * 60 * 1000);
  }

  // ─── Init ────────────────────────────────────────────────────────────────────

  /**
   * Load semua session dari DB ke in-memory Map.
   * Dipanggil SEKALI saat bot start dari bot.js (setelah koneksi terbuka).
   * Session yang sudah expired saat load langsung dibuang.
   */
  async loadFromDb() {
    try {
      const docs = db.find(COLLECTION, {});
      const now = Date.now();
      let loaded = 0;
      let expired = 0;

      for (const doc of docs) {
        const lastUsed = new Date(doc.lastUsed).getTime();
        if (now - lastUsed > this._ttl) {
          // Sudah expired — hapus dari DB sekalian
          await db.delete(COLLECTION, { jid: doc.jid });
          expired++;
        } else {
          this._store.set(doc.jid, {
            sessionId: doc.sessionId,
            lastUsed,
          });
          loaded++;
        }
      }

      logger.info({ loaded, expired }, '📦 sessionStore: session dimuat dari DB');
    } catch (err) {
      logger.error({ err: err.message }, '❌ sessionStore: gagal load dari DB');
    }
  }

  // ─── Public API ───────────────────────────────────────────────────────────────

  /**
   * Ambil session ID untuk JID tertentu.
   * Cek memory dulu, jika tidak ada cek DB (fallback untuk race condition).
   *
   * @param {string} jid
   * @returns {string|null}
   */
  get(jid) {
    const entry = this._store.get(jid);
    if (!entry) return null;

    // Cek TTL
    if (Date.now() - entry.lastUsed > this._ttl) {
      this._store.delete(jid);
      // Hapus dari DB juga (fire-and-forget)
      db.delete(COLLECTION, { jid }).catch(() => {});
      logger.debug({ jid }, '🕐 sessionStore: session expired, dihapus');
      return null;
    }

    return entry.sessionId;
  }

  /**
   * Simpan/update session ID untuk JID.
   * Tulis ke memory DAN DB secara bersamaan.
   *
   * @param {string} jid
   * @param {string} sessionId
   */
  set(jid, sessionId) {
    const lastUsed = Date.now();

    // Tulis ke memory
    this._store.set(jid, { sessionId, lastUsed });

    // Persist ke DB (fire-and-forget — tidak blokir alur chat)
    db.upsert(COLLECTION, { jid }, {
      jid,
      sessionId,
      lastUsed: new Date(lastUsed).toISOString(),
    }).catch((err) => {
      logger.warn({ jid, err: err.message }, '⚠️ sessionStore: gagal persist ke DB');
    });
  }

  /**
   * Hapus session untuk JID (reset percakapan).
   * Hapus dari memory DAN DB.
   *
   * @param {string} jid
   */
  delete(jid) {
    this._store.delete(jid);
    db.delete(COLLECTION, { jid }).catch(() => {});
    logger.debug({ jid }, '🗑️ sessionStore: session dihapus');
  }

  /**
   * Hapus semua session (reset total).
   */
  clear() {
    this._store.clear();
    // Hapus semua dokumen di collection (iterasi karena db mungkin tidak support deleteMany)
    try {
      const docs = db.find(COLLECTION, {});
      for (const doc of docs) {
        db.delete(COLLECTION, { jid: doc.jid }).catch(() => {});
      }
    } catch (err) {
      logger.warn({ err: err.message }, '⚠️ sessionStore: gagal clear DB');
    }
    logger.info('🗑️ sessionStore: semua session dibersihkan');
  }

  /**
   * Perbarui `lastUsed` untuk JID tanpa mengubah sessionId.
   * Dipanggil setiap kali session digunakan agar TTL tidak expired prematur.
   *
   * @param {string} jid
   */
  touch(jid) {
    const entry = this._store.get(jid);
    if (!entry) return;

    entry.lastUsed = Date.now();
    this._store.set(jid, entry);

    db.update(COLLECTION, { jid }, {
      lastUsed: new Date(entry.lastUsed).toISOString(),
    }).catch(() => {});
  }

  /**
   * Info semua session aktif (untuk debug/logging).
   * @returns {Array}
   */
  list() {
    return Array.from(this._store.entries()).map(([jid, entry]) => ({
      jid,
      sessionId: entry.sessionId.slice(0, 8) + '...',
      lastUsed: new Date(entry.lastUsed).toISOString(),
    }));
  }

  /**
   * Jumlah session aktif di memory.
   * @returns {number}
   */
  size() {
    return this._store.size;
  }

  // ─── Private ──────────────────────────────────────────────────────────────────

  /**
   * Bersihkan session expired dari memory dan DB.
   * Berjalan otomatis setiap 10 menit via setInterval.
   *
   * Sejak sesi di server TIDAK punya TTL otomatis lagi (API_USAGE.md
   * §6.2.1), TTL di sini murni kebijakan bot (rolling 24 jam per-JID,
   * lihat config.sessionTtl). Sebelum benar-benar membuang sesi expired,
   * kita:
   *   1. Ringkas chatHistory jid tsb ke memory bank (memoryService) —
   *      supaya sesi baru berikutnya tidak "amnesia" total.
   *   2. Hapus sesi di SERVER via DELETE /v1/sessions/{id} (aiService) —
   *      kebersihan sisi server, mencegah sesi menumpuk selamanya.
   *   3. Baru hapus mapping lokal (memory + DB) seperti sebelumnya.
   *
   * Kedua langkah 1 & 2 dilakukan lazy-import untuk menghindari circular
   * dependency (aiService.js mengimpor sessionStore.js untuk get/set).
   */
  async _cleanup() {
    const now = Date.now();
    let removed = 0;

    const expired = [];
    for (const [jid, entry] of this._store.entries()) {
      if (now - entry.lastUsed > this._ttl) {
        expired.push({ jid, sessionId: entry.sessionId });
      }
    }

    if (expired.length === 0) return;

    // Lazy import — hindari circular dependency dengan aiService/memoryService
    let deleteRemoteSession = null;
    let isRealContactJid = null;
    let summarizeAndRemember = null;
    try {
      const aiService = await import('./aiService.js');
      const memoryService = await import('./memoryService.js');
      deleteRemoteSession = aiService.deleteRemoteSession;
      isRealContactJid = memoryService.isRealContactJid;
      summarizeAndRemember = memoryService.summarizeAndRemember;
    } catch (err) {
      logger.warn({ err: err.message }, '⚠️ sessionStore: gagal lazy-import aiService/memoryService saat cleanup');
    }

    for (const { jid, sessionId } of expired) {
      // 1. Ringkas ke memory bank SEBELUM sesi dihapus (hanya untuk jid nyata)
      if (summarizeAndRemember && isRealContactJid?.(jid)) {
        await summarizeAndRemember(jid, 'ttl_expired').catch((err) =>
          logger.warn({ jid, err: err.message }, '⚠️ sessionStore: gagal summarize sebelum cleanup')
        );
      }

      // 2. Hapus sesi di server (best-effort, tidak menghentikan cleanup jika gagal)
      if (deleteRemoteSession) {
        await deleteRemoteSession(sessionId).catch(() => {});
      }

      // 3. Hapus mapping lokal
      this._store.delete(jid);
      await db.delete(COLLECTION, { jid }).catch(() => {});
      removed++;
    }

    if (removed > 0) {
      logger.debug({ removed }, '🧹 sessionStore: cleanup session expired (24 jam rolling, sudah diringkas ke memory bank)');
    }
  }
}

// Singleton — satu instance untuk seluruh aplikasi
export const sessionStore = new SessionStore();