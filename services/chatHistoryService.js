// services/chatHistoryService.js
// Mencatat semua pesan chat natural (bukan command) per JID ke database.
// Data yang dicatat: jid, role (user/bot), teks, waktu.
// Retention: hanya 2 hari terakhir. Cleanup otomatis saat record dan saat analisa.

import db from './db.js';
import logger from '../utils/logger.js';

const COLLECTION = 'chatHistory';
const RETENTION_MS = 2 * 24 * 60 * 60 * 1000; // 2 hari dalam ms

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Hitung batas waktu 2 hari yang lalu (ISO string)
 */
function getRetentionCutoff() {
  return new Date(Date.now() - RETENTION_MS).toISOString();
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Catat satu pesan ke chatHistory.
 * Dipanggil dari messageHandler setiap kali ada pesan natural masuk/keluar.
 *
 * @param {object} options
 * @param {string} options.jid    - JID kontak atau grup
 * @param {string} options.role   - 'user' | 'bot'
 * @param {string} options.text   - isi pesan
 * @param {string} [options.sender] - JID pengirim (untuk grup, bisa berbeda dengan jid)
 */
export async function recordMessage({ jid, role, text, sender }) {
  if (!jid || !text?.trim()) return;

  try {
    // Cleanup dulu sebelum insert agar file tidak terus membengkak
    await pruneOldMessages(jid);

    const entry = {
      jid,
      role,        // 'user' | 'bot'
      text: text.trim(),
      sender: sender || jid,
      timestamp: new Date().toISOString(),
    };

    await db.insert(COLLECTION, entry);
    logger.debug({ jid, role, chars: text.length }, '💬 chatHistory: pesan dicatat');
  } catch (err) {
    logger.error({ jid, err: err.message }, '❌ chatHistoryService: gagal catat pesan');
  }
}

/**
 * Ambil semua history chat untuk satu JID dalam 2 hari terakhir.
 * Diurutkan dari paling lama ke paling baru.
 *
 * @param {string} jid
 * @returns {object[]} array entry { jid, role, text, sender, timestamp, firstSent, lastSent }
 */
export function getHistory(jid) {
  const cutoff = getRetentionCutoff();
  const all = db.find(COLLECTION, { jid });

  const filtered = all
    .filter((entry) => entry.timestamp >= cutoff)
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  if (filtered.length === 0) return [];

  const firstSent = filtered[0].timestamp;
  const lastSent = filtered[filtered.length - 1].timestamp;

  return filtered.map((entry) => ({ ...entry, firstSent, lastSent }));
}

/**
 * Ambil semua JID yang punya history aktif (dalam 2 hari terakhir).
 *
 * @returns {string[]} array JID unik
 */
export function getActiveJids() {
  const cutoff = getRetentionCutoff();
  const all = db.find(COLLECTION, {});
  const jidSet = new Set(
    all.filter((e) => e.timestamp >= cutoff).map((e) => e.jid)
  );
  return Array.from(jidSet);
}

/**
 * Ringkasan metadata history per JID — untuk keperluan logging/debug.
 *
 * @param {string} jid
 * @returns {{ jid, messageCount, firstSent, lastSent } | null}
 */
export function getHistorySummary(jid) {
  const history = getHistory(jid);
  if (history.length === 0) return null;

  return {
    jid,
    messageCount: history.length,
    firstSent: history[0].firstSent,
    lastSent: history[history.length - 1].lastSent,
  };
}

/**
 * Hapus pesan lama (> 2 hari) untuk satu JID.
 * Dipanggil otomatis saat recordMessage.
 *
 * @param {string} jid
 */
async function pruneOldMessages(jid) {
  const cutoff = getRetentionCutoff();
  const all = db.find(COLLECTION, { jid });
  const expired = all.filter((e) => e.timestamp < cutoff);

  for (const entry of expired) {
    await db.delete(COLLECTION, { _id: entry._id });
  }

  if (expired.length > 0) {
    logger.debug({ jid, removed: expired.length }, '🧹 chatHistory: pesan lama dibersihkan');
  }
}

/**
 * Global cleanup semua JID — dijalankan sekali saat bot start
 * dan bisa dipanggil manual dari proactiveService.
 */
export async function pruneAllOldMessages() {
  const cutoff = getRetentionCutoff();
  const all = db.find(COLLECTION, {});
  const expired = all.filter((e) => e.timestamp < cutoff);

  for (const entry of expired) {
    await db.delete(COLLECTION, { _id: entry._id });
  }

  if (expired.length > 0) {
    logger.info({ removed: expired.length }, '🧹 chatHistory: global cleanup selesai');
  }
}