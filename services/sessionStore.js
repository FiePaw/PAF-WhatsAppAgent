// services/sessionStore.js
// In-memory store untuk menyimpan X-Session-ID dari API server per JID
import config from '../config/config.js';
import logger from '../utils/logger.js';

class SessionStore {
  constructor() {
    // Map<jid, { sessionId, lastUsed }>
    this._store = new Map();
    this._ttl = config.sessionTtl;

    // Auto-cleanup setiap 10 menit
    setInterval(() => this._cleanup(), 10 * 60 * 1000);
  }

  /**
   * Ambil session ID untuk JID tertentu
   * @param {string} jid
   * @returns {string|null}
   */
  get(jid) {
    const entry = this._store.get(jid);
    if (!entry) return null;

    // Cek TTL
    if (Date.now() - entry.lastUsed > this._ttl) {
      this._store.delete(jid);
      logger.debug({ jid }, 'Session expired, dihapus dari store');
      return null;
    }

    return entry.sessionId;
  }

  /**
   * Simpan/update session ID untuk JID
   * @param {string} jid
   * @param {string} sessionId
   */
  set(jid, sessionId) {
    this._store.set(jid, {
      sessionId,
      lastUsed: Date.now(),
    });
  }

  /**
   * Hapus session untuk JID (reset percakapan)
   * @param {string} jid
   */
  delete(jid) {
    this._store.delete(jid);
    logger.debug({ jid }, 'Session dihapus dari store');
  }

  /**
   * Hapus semua session
   */
  clear() {
    this._store.clear();
    logger.info('Semua session dibersihkan');
  }

  /**
   * Info semua session aktif
   * @returns {Array}
   */
  list() {
    return Array.from(this._store.entries()).map(([jid, entry]) => ({
      jid,
      sessionId: entry.sessionId.slice(0, 8) + '...',
      lastUsed: new Date(entry.lastUsed).toISOString(),
    }));
  }

  // Private: bersihkan session yang expired
  _cleanup() {
    const now = Date.now();
    let removed = 0;
    for (const [jid, entry] of this._store.entries()) {
      if (now - entry.lastUsed > this._ttl) {
        this._store.delete(jid);
        removed++;
      }
    }
    if (removed > 0) {
      logger.debug({ removed }, 'Session cleanup selesai');
    }
  }
}

// Singleton
export const sessionStore = new SessionStore();
