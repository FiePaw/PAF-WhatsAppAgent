// services/chatHistoryService.js
//
// Struktur database: satu collection "chatHistory", satu dokumen per JID.
//
// Setiap dokumen berbentuk:
// {
//   _id:          string,           // auto dari db
//   jid:          string,           // identifier unik kontak/grup
//   firstSeen:    ISO string,       // kapan pertama kali JID ini muncul
//   lastSeen:     ISO string,       // kapan pesan terakhir diterima/dikirim
//   messageCount: number,           // total pesan sepanjang masa (tidak di-reset)
//   messages: [                     // array pesan 2 hari terakhir
//     {
//       role:      'user' | 'bot',
//       text:      string,
//       sender:    string,          // JID pengirim (relevan untuk grup)
//       timestamp: ISO string,
//     },
//     ...
//   ]
// }
//
// Keuntungan struktur ini:
// - Satu read/write per JID → tidak perlu scan seluruh collection
// - Metadata (firstSeen, lastSeen, messageCount) dan messages dalam satu dokumen
// - Mudah dibaca langsung dari file data/chatHistory.json
// - Tidak ada dua collection terpisah yang bisa tidak sinkron

import db from './db.js';
import logger from '../utils/logger.js';

// Lazy import — hindari circular dependency dengan proactiveService
let _onNewJid = null;
async function getOnNewJid() {
  if (!_onNewJid) {
    const mod = await import('./proactiveService.js');
    _onNewJid = mod.onNewJid;
  }
  return _onNewJid;
}

const COLLECTION   = 'chatHistory';
const RETENTION_MS = 2 * 24 * 60 * 60 * 1000; // 2 hari

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getRetentionCutoff() {
  return new Date(Date.now() - RETENTION_MS).toISOString();
}

/**
 * Ambil dokumen JID dari DB. Return null jika belum ada.
 * @param {string} jid
 * @returns {object|null}
 */
function getJidDoc(jid) {
  return db.findOne(COLLECTION, { jid });
}

/**
 * Buang pesan dalam array messages[] yang sudah lebih dari 2 hari.
 * @param {object[]} messages
 * @returns {object[]}
 */
function pruneMessages(messages) {
  const cutoff = getRetentionCutoff();
  return messages.filter((m) => m.timestamp >= cutoff);
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Catat satu pesan ke history JID.
 * Jika dokumen JID belum ada → buat baru (firstSeen = sekarang).
 * Jika sudah ada → append pesan + update lastSeen & messageCount.
 * Pesan > 2 hari otomatis dibuang saat operasi ini.
 *
 * @param {object} options
 * @param {string} options.jid
 * @param {string} options.role     - 'user' | 'bot'
 * @param {string} options.text
 * @param {string} [options.sender]
 */
export async function recordMessage({ jid, role, text, sender }) {
  if (!jid || !text?.trim()) return;

  try {
    const now = new Date().toISOString();
    const existing = getJidDoc(jid);

    const newMessage = {
      role,
      text:      text.trim(),
      sender:    sender || jid,
      timestamp: now,
    };

    if (!existing) {
      // ── JID baru: buat dokumen pertama ──────────────────────────────────
      await db.insert(COLLECTION, {
        jid,
        firstSeen:    now,
        lastSeen:     now,
        messageCount: 1,
        messages:     [newMessage],
      });

      logger.info({ jid }, '🆕 chatHistory: JID baru, dokumen dibuat');
      // Notify proactiveService agar subscribe presence JID ini
      getOnNewJid().then((fn) => fn(jid)).catch(() => {});

    } else {
      // ── JID sudah ada: prune lama + append baru ──────────────────────────
      const prunedMessages = pruneMessages(existing.messages ?? []);
      prunedMessages.push(newMessage);

      await db.update(COLLECTION, { jid }, {
        lastSeen:     now,
        messageCount: (existing.messageCount ?? 0) + 1,
        messages:     prunedMessages,
      });

      logger.debug({ jid, role, total: prunedMessages.length }, '💬 chatHistory: pesan ditambahkan');
    }
  } catch (err) {
    logger.error({ jid, err: err.message }, '❌ chatHistoryService: gagal catat pesan');
  }
}

/**
 * Ambil array pesan aktif (2 hari terakhir) untuk satu JID.
 * Setiap pesan dilengkapi firstSent dan lastSent dari batch.
 *
 * @param {string} jid
 * @returns {object[]}
 */
export function getHistory(jid) {
  const doc = getJidDoc(jid);
  if (!doc || !doc.messages?.length) return [];

  const active = pruneMessages(doc.messages)
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  if (active.length === 0) return [];

  const firstSent = active[0].timestamp;
  const lastSent  = active[active.length - 1].timestamp;

  return active.map((m) => ({ ...m, jid, firstSent, lastSent }));
}

/**
 * Ambil semua JID yang masih punya pesan aktif dalam 2 hari terakhir.
 * Digunakan oleh proactiveService untuk menentukan JID mana yang perlu dianalisa.
 *
 * @returns {string[]}
 */
export function getActiveJids() {
  const cutoff = getRetentionCutoff();
  return db.find(COLLECTION, {})
    .filter((doc) =>
      Array.isArray(doc.messages) &&
      doc.messages.some((m) => m.timestamp >= cutoff)
    )
    .map((doc) => doc.jid);
}

/**
 * Ambil semua JID yang pernah tercatat (persistent, tidak terikat retention).
 * Digunakan saat bot restart untuk subscribe presence semua JID yang dikenal.
 *
 * @returns {string[]}
 */
export function getAllKnownJids() {
  return db.find(COLLECTION, {}).map((doc) => doc.jid);
}

/**
 * Ringkasan lengkap satu JID: metadata + statistik history aktif.
 *
 * @param {string} jid
 * @returns {{
 *   jid, firstSeen, lastSeen, messageCount,
 *   activeMessages, firstSent, lastSent
 * } | null}
 */
export function getJidSummary(jid) {
  const doc = getJidDoc(jid);
  if (!doc) return null;

  const active = pruneMessages(doc.messages ?? []);

  return {
    jid,
    firstSeen:      doc.firstSeen,
    lastSeen:       doc.lastSeen,
    messageCount:   doc.messageCount,   // total sepanjang masa
    activeMessages: active.length,      // dalam 2 hari terakhir
    firstSent:      active[0]?.timestamp ?? null,
    lastSent:       active[active.length - 1]?.timestamp ?? null,
  };
}

/**
 * Buang pesan > 2 hari dari semua dokumen JID.
 * Dipanggil saat bot start dan setiap siklus proactiveService.
 * Dokumen JID itu sendiri tidak dihapus — hanya array messages[] yang dipangkas.
 */
export async function pruneAllOldMessages() {
  const docs = db.find(COLLECTION, {});
  let totalRemoved = 0;

  for (const doc of docs) {
    const before  = doc.messages?.length ?? 0;
    const pruned  = pruneMessages(doc.messages ?? []);
    const removed = before - pruned.length;

    if (removed > 0) {
      await db.update(COLLECTION, { jid: doc.jid }, { messages: pruned });
      totalRemoved += removed;
      logger.debug({ jid: doc.jid, removed }, '🧹 chatHistory: pesan lama dibersihkan');
    }
  }

  if (totalRemoved > 0) {
    logger.info({ totalRemoved }, '🧹 chatHistory: global cleanup selesai');
  }
}