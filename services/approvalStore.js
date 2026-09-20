// services/approvalStore.js
// [Fitur 2 · Approval Owner untuk Membalas Nomor Lain]
//
// Mengelola status approval nomor non-owner: whitelist (boleh dibalas AI
// langsung sampai `approvedUntil`), blocklist (ditolak permanen, tidak akan
// ditanya lagi kecuali owner override manual), dan pending requests (nomor
// yang sedang menunggu keputusan owner).
//
// Pola sama seperti services/sessionStore.js:
//   - In-memory Map sebagai sumber kebenaran saat runtime (akses cepat)
//   - Persist status whitelist/blocklist ke DB (collection "approvals"),
//     survive restart bot
//   - Auto-cleanup via setInterval: whitelist expired dibuang, pending yang
//     sudah 24 jam tanpa respons owner otomatis di-deny (auto-deny)
//
// Pending requests (Map messageId -> data) SENGAJA hanya in-memory (tidak
// dipersist ke DB) — jika bot restart saat ada pending, request tersebut
// hilang dan sender perlu mengirim ulang pesan untuk memicu approval baru.
// Ini trade-off yang wajar mengingat pending umumnya berumur pendek (owner
// diharapkan merespons, atau timeout 24 jam) dan menyimpan attachment
// (base64, bisa besar) ke DB JSON flat-file kurang ideal.

import db from './db.js';
import logger from '../utils/logger.js';

const APPROVAL_COL = 'approvals'; // { jid, status: 'whitelisted'|'blocked', approvedUntil, blockedAt }
const DEFAULT_APPROVAL_HOURS = 24;
const PENDING_TIMEOUT_MS = 24 * 60 * 60 * 1000; // 24 jam
const CLEANUP_INTERVAL_MS = 10 * 60 * 1000; // cek tiap 10 menit

// In-memory cache: jid -> { status, approvedUntil }
const _statusCache = new Map();

// In-memory only: messageId (notifikasi approval) -> { senderJid, chatJid, originalText, attachments, requestedAt }
const _pending = new Map();

// ─── Init: load status dari DB ke cache ─────────────────────────────────
function _loadStatusCache() {
  _statusCache.clear();
  const all = db.find(APPROVAL_COL, {});
  for (const doc of all) {
    _statusCache.set(doc.jid, { status: doc.status, approvedUntil: doc.approvedUntil || null });
  }
  logger.info({ size: _statusCache.size }, '📦 approvalStore: status dimuat dari DB');
}
_loadStatusCache();

// ─── Query status ────────────────────────────────────────────────────────

/**
 * Cek apakah jid sedang whitelisted (boleh dibalas AI langsung).
 * Whitelist yang sudah expired otomatis dibuang saat dicek (lazy cleanup)
 * dan dianggap TIDAK whitelisted (fallback ke alur approval lagi jika chat).
 *
 * @param {string} jid
 * @returns {boolean}
 */
export function isWhitelisted(jid) {
  const entry = _statusCache.get(jid);
  if (!entry || entry.status !== 'whitelisted') return false;

  if (entry.approvedUntil && Date.now() > new Date(entry.approvedUntil).getTime()) {
    _statusCache.delete(jid);
    db.delete(APPROVAL_COL, { jid }).catch(() => {});
    logger.debug({ jid }, '🕐 approvalStore: whitelist expired (lazy check)');
    return false;
  }

  return true;
}

/**
 * Cek apakah jid ada di blocklist (ditolak permanen).
 * @param {string} jid
 * @returns {boolean}
 */
export function isBlocked(jid) {
  const entry = _statusCache.get(jid);
  return !!entry && entry.status === 'blocked';
}

/**
 * Whitelist jid selama N jam (default 24 jam sejak sekarang).
 * @param {string} jid
 * @param {number} [hours]
 */
export async function approve(jid, hours = DEFAULT_APPROVAL_HOURS) {
  const approvedUntil = new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
  _statusCache.set(jid, { status: 'whitelisted', approvedUntil });
  await db.upsert(APPROVAL_COL, { jid }, { jid, status: 'whitelisted', approvedUntil, blockedAt: null });
  logger.info({ jid, approvedUntil, hours }, '✅ approvalStore: jid di-whitelist');
}

/**
 * Blokir jid secara permanen (tanpa expiry) — hanya bisa dihapus manual via unblock().
 * @param {string} jid
 */
export async function deny(jid) {
  const blockedAt = new Date().toISOString();
  _statusCache.set(jid, { status: 'blocked', approvedUntil: null });
  await db.upsert(APPROVAL_COL, { jid }, { jid, status: 'blocked', approvedUntil: null, blockedAt });
  logger.info({ jid }, '🚫 approvalStore: jid di-blocklist');
}

/**
 * Hapus status approval (whitelist/blocklist) untuk jid — kembali ke
 * "belum ada status" sehingga akan melalui alur approval lagi jika chat lagi.
 * @param {string} jid
 */
export async function unblock(jid) {
  _statusCache.delete(jid);
  await db.delete(APPROVAL_COL, { jid });
  logger.info({ jid }, '🗑️ approvalStore: status jid dihapus');
}

/**
 * List semua entry approval (whitelist + blocklist) untuk keperluan debug/admin.
 * @returns {{ jid: string, status: string, approvedUntil: string|null }[]}
 */
export function listStatuses() {
  return Array.from(_statusCache.entries()).map(([jid, entry]) => ({ jid, ...entry }));
}

// ─── Pending requests (in-memory, keyed by messageId notifikasi) ────────

/**
 * Simpan pending approval request, keyed by messageId hasil sock.sendMessage()
 * saat mengirim notifikasi ke owner.
 *
 * @param {string} messageId
 * @param {{ senderJid: string, chatJid: string, originalText: string, attachments: Array|null }} data
 */
export function addPending(messageId, data) {
  _pending.set(messageId, { ...data, requestedAt: Date.now() });
}

/**
 * Ambil satu pending request berdasarkan messageId (dipakai saat owner reply
 * ke notifikasi — dicocokkan via contextInfo.stanzaId).
 *
 * @param {string} messageId
 * @returns {object|null}
 */
export function getPending(messageId) {
  return _pending.get(messageId) || null;
}

/**
 * Hapus satu pending request.
 * @param {string} messageId
 */
export function removePending(messageId) {
  _pending.delete(messageId);
}

/**
 * Ambil semua pending request dari satu senderJid — dipakai saat owner
 * approve/deny untuk memproses/membuang SEMUA pesan yang sempat menumpuk,
 * bukan cuma pesan yang notifikasinya di-reply.
 *
 * @param {string} senderJid
 * @returns {{ messageId: string, senderJid: string, chatJid: string, originalText: string, attachments: Array|null, requestedAt: number }[]}
 */
export function getPendingForSender(senderJid) {
  const result = [];
  for (const [messageId, data] of _pending.entries()) {
    if (data.senderJid === senderJid) result.push({ messageId, ...data });
  }
  return result;
}

/**
 * List semua pending request aktif — dipakai command !approvals.
 * @returns {object[]}
 */
export function listPending() {
  return Array.from(_pending.entries()).map(([messageId, data]) => ({ messageId, ...data }));
}

// ─── Auto-cleanup ─────────────────────────────────────────────────────────
// Tiap 10 menit: buang whitelist expired, dan auto-deny pending yang sudah
// 24 jam tanpa respons owner (dianggap ditolak, sama seperti deny eksplisit).
setInterval(async () => {
  const now = Date.now();

  for (const [jid, entry] of _statusCache.entries()) {
    if (entry.status === 'whitelisted' && entry.approvedUntil && now > new Date(entry.approvedUntil).getTime()) {
      _statusCache.delete(jid);
      await db.delete(APPROVAL_COL, { jid }).catch(() => {});
      logger.debug({ jid }, '🕐 approvalStore: cleanup — whitelist expired dihapus');
    }
  }

  const timedOut = [];
  for (const [messageId, data] of _pending.entries()) {
    if (now - data.requestedAt > PENDING_TIMEOUT_MS) {
      timedOut.push({ messageId, senderJid: data.senderJid });
    }
  }

  for (const { messageId, senderJid } of timedOut) {
    _pending.delete(messageId);
    // Jangan double-deny kalau sender sudah sempat diputuskan lewat pending lain
    if (!isBlocked(senderJid) && !isWhitelisted(senderJid)) {
      await deny(senderJid);
      logger.info({ senderJid }, '⏰ approvalStore: pending timeout 24 jam, auto-deny');
    }
  }
}, CLEANUP_INTERVAL_MS);

export default {
  isWhitelisted,
  isBlocked,
  approve,
  deny,
  unblock,
  listStatuses,
  addPending,
  getPending,
  removePending,
  getPendingForSender,
  listPending,
};
