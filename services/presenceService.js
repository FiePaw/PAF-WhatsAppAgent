// services/presenceService.js
// Melacak status online/offline setiap JID yang ada di chatHistory.
//
// Cara kerja:
// 1. saat bot start → subscribeAll() dipanggil → bot subscribe ke presence semua JID aktif
// 2. bot.js listen event 'presence.update' → panggil updatePresence()
// 3. proactiveService baca getPresence(jid) saat analisa per jam
//
// Keterbatasan WhatsApp:
// - User bisa sembunyikan "last seen" → presence tidak selalu akurat
// - Subscribe perlu dipanggil ulang setelah reconnect
// - Presence dianggap stale jika tidak ada update > STALE_THRESHOLD

import db from './db.js';
import logger from '../utils/logger.js';

const COLLECTION = 'presenceCache';

// Presence dianggap stale (tidak diketahui) jika tidak ada update lebih dari 10 menit
const STALE_THRESHOLD_MS = 10 * 60 * 1000;

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Subscribe ke presence update untuk satu JID.
 * Dipanggil saat JID baru muncul di chatHistory atau saat bot start.
 *
 * @param {string} jid
 */
export async function subscribePresence(jid) {
  const sock = global._sock;
  if (!sock) return;
  try {
    await sock.presenceSubscribe(jid);
    logger.debug({ jid }, '👁️ presenceService: subscribe presence');
  } catch (err) {
    logger.warn({ jid, err: err.message }, '⚠️ presenceService: gagal subscribe presence');
  }
}

/**
 * Subscribe ke semua JID aktif di chatHistory.
 * Dipanggil saat bot start / reconnect.
 *
 * @param {string[]} activeJids - dari chatHistoryService.getActiveJids()
 */
export async function subscribeAll(activeJids) {
  if (!activeJids?.length) return;
  logger.info({ count: activeJids.length }, '👁️ presenceService: subscribe ke semua JID aktif...');
  for (const jid of activeJids) {
    await subscribePresence(jid);
    // Jeda kecil agar tidak flood
    await new Promise((r) => setTimeout(r, 300));
  }
  logger.info('✅ presenceService: semua JID berhasil di-subscribe');
}

/**
 * Handle event presence.update dari Baileys.
 * Simpan status terakhir per JID ke DB.
 *
 * Dipanggil dari bot.js:
 *   sock.ev.on('presence.update', ({ id, presences }) => updatePresence(id, presences));
 *
 * @param {string} id        - JID kontak
 * @param {object} presences - map { jid: { lastKnownPresence, lastSeen } }
 */
export async function updatePresence(id, presences) {
  try {
    // Ambil presence untuk JID itu sendiri (bukan dalam group)
    const presenceData = presences[id] || Object.values(presences)[0];
    if (!presenceData) return;

    const { lastKnownPresence, lastSeen } = presenceData;

    await db.upsert(COLLECTION, { jid: id }, {
      jid: id,
      lastKnownPresence,              // 'available' | 'unavailable' | 'composing' | 'paused'
      lastSeen: lastSeen
        ? new Date(lastSeen * 1000).toISOString()
        : null,
      updatedAt: new Date().toISOString(),
    });

    logger.debug({ jid: id, status: lastKnownPresence }, '📶 presenceService: status diperbarui');
  } catch (err) {
    logger.warn({ jid: id, err: err.message }, '⚠️ presenceService: gagal update presence');
  }
}

/**
 * Ambil status presence terakhir yang diketahui untuk satu JID.
 *
 * @param {string} jid
 * @returns {{
 *   isOnline: boolean,
 *   lastKnownPresence: string,   // 'available'|'unavailable'|'composing'|'paused'|'unknown'
 *   lastSeen: string|null,       // ISO string atau null
 *   isStale: boolean             // true jika data > 10 menit (tidak bisa dipercaya)
 * }}
 */
export function getPresence(jid) {
  const record = db.findOne(COLLECTION, { jid });

  if (!record) {
    return {
      isOnline: false,
      lastKnownPresence: 'unknown',
      lastSeen: null,
      isStale: true,
    };
  }

  const ageMs = Date.now() - new Date(record.updatedAt).getTime();
  const isStale = ageMs > STALE_THRESHOLD_MS;

  const isOnline =
    !isStale &&
    (record.lastKnownPresence === 'available' || record.lastKnownPresence === 'composing');

  return {
    isOnline,
    lastKnownPresence: record.lastKnownPresence ?? 'unknown',
    lastSeen: record.lastSeen ?? null,
    isStale,
  };
}