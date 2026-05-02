// services/groupService.js
// Manajemen grup WhatsApp untuk bot:
//   - Buat grup baru dan tambahkan owner
//   - Hapus grup dari daftar (bot leave + hapus record)
//   - Assign grup sebagai channel input/output untuk plugin tertentu
//   - getGroupOutput(pluginKey) → dipakai plugin untuk kirim output ke grup
//   - getGroupChannel(jid)     → dipakai messageHandler untuk routing input
//
// Data disimpan di db collection "groups":
// {
//   _id: string,
//   groupJid: string,       // JID grup (@g.us)
//   name: string,           // nama grup
//   channels: {             // mapping plugin key → role
//     [pluginKey]: 'input' | 'output' | 'both'
//   }
// }

import db from './db.js';
import config from '../config/config.js';
import logger from '../utils/logger.js';

const COLLECTION = 'groups';

// ─── In-memory cache channel map ─────────────────────────────────────────
// Map<groupJid, { input: boolean, output: boolean, plugins: string[] }>
// Di-rebuild dari DB saat init dan setiap kali ada perubahan.
let _channelCache = new Map();

function _rebuildCache() {
  _channelCache.clear();
  const all = db.find(COLLECTION, {});
  for (const group of all) {
    const channels = group.channels || {};
    const plugins = Object.keys(channels);
    if (!plugins.length) continue;

    const roles = Object.values(channels);
    _channelCache.set(group.groupJid, {
      input: roles.some((r) => r === 'input' || r === 'both'),
      output: roles.some((r) => r === 'output' || r === 'both'),
      plugins,
      channels,
      name: group.name,
    });
  }
  logger.debug({ size: _channelCache.size }, '🔄 Group channel cache rebuilt');
}

// Init cache saat module di-load
_rebuildCache();

// ─── Buat grup baru ───────────────────────────────────────────────────────
/**
 * Buat grup WhatsApp baru dan tambahkan owner ke dalamnya.
 * Baileys createGroup membutuhkan array peserta (selain diri sendiri).
 * Owner otomatis ditambahkan — bot sendiri sudah jadi admin secara default.
 *
 * @param {object} sock
 * @param {string} groupName
 * @returns {Promise<{ success: boolean, groupJid?: string, name?: string, error?: string }>}
 */
export async function createGroup(sock, groupName) {
  try {
    const ownerJid = config.ownerLid || config.ownerJid;

    // Baileys createGroup(subject, participants)
    // participants: array JID yang akan diundang (harus @s.whatsapp.net, bukan @lid)
    // Gunakan ownerJid format @s.whatsapp.net agar tidak bad-request
    const ownerPhone = config.ownerJid; // selalu @s.whatsapp.net

    const result = await sock.groupCreate(groupName, [ownerPhone]);

    if (!result?.id) {
      return { success: false, error: 'Grup gagal dibuat, tidak ada ID yang dikembalikan' };
    }

    const groupJid = result.id;

    // Simpan ke DB
    await db.insert(COLLECTION, {
      groupJid,
      name: groupName,
      channels: {},
    });

    _rebuildCache();

    logger.info({ groupJid, groupName }, '✅ Grup baru dibuat');
    return { success: true, groupJid, name: groupName };
  } catch (err) {
    logger.error({ groupName, err: err.message }, '❌ Gagal membuat grup');
    return { success: false, error: err.message };
  }
}

// ─── Hapus / keluar dari grup ─────────────────────────────────────────────
/**
 * Bot keluar dari grup dan hapus record dari DB.
 *
 * @param {object} sock
 * @param {string} groupJid
 * @returns {Promise<{ success: boolean, error?: string }>}
 */
export async function deleteGroup(sock, groupJid) {
  try {
    // Bot leave grup
    await sock.groupLeave(groupJid);
  } catch (err) {
    // Jika sudah tidak ada di grup, lanjut hapus dari DB
    logger.warn({ groupJid, err: err.message }, '⚠️ groupLeave gagal (mungkin sudah keluar), lanjut hapus DB');
  }

  try {
    await db.delete(COLLECTION, { groupJid });
    _rebuildCache();
    logger.info({ groupJid }, '🗑️ Grup dihapus dari daftar');
    return { success: true };
  } catch (err) {
    logger.error({ groupJid, err: err.message }, '❌ Gagal hapus grup dari DB');
    return { success: false, error: err.message };
  }
}

// ─── Set channel grup ─────────────────────────────────────────────────────
/**
 * Assign grup sebagai channel input/output untuk plugin tertentu.
 *
 * @param {string} groupJid
 * @param {string} pluginKey  - nama plugin/sistem (misal: 'reminder', 'broadcast')
 * @param {'input'|'output'|'both'|'none'} role
 * @returns {Promise<{ success: boolean, error?: string }>}
 */
export async function setGroupChannel(groupJid, pluginKey, role) {
  try {
    const group = db.findOne(COLLECTION, { groupJid });
    if (!group) {
      return { success: false, error: 'Grup tidak ditemukan di daftar' };
    }

    const channels = group.channels || {};

    if (role === 'none') {
      delete channels[pluginKey];
    } else {
      channels[pluginKey] = role;
    }

    await db.update(COLLECTION, { groupJid }, { channels });
    _rebuildCache();

    logger.info({ groupJid, pluginKey, role }, '✅ Group channel diset');
    return { success: true };
  } catch (err) {
    logger.error({ groupJid, pluginKey, err: err.message }, '❌ Gagal set group channel');
    return { success: false, error: err.message };
  }
}

// ─── Tambah grup existing ke daftar ──────────────────────────────────────
/**
 * Daftarkan grup yang sudah ada (bot sudah di dalamnya) ke DB.
 *
 * @param {string} groupJid
 * @param {string} groupName
 * @returns {Promise<{ success: boolean, error?: string }>}
 */
export async function registerGroup(groupJid, groupName) {
  try {
    const existing = db.findOne(COLLECTION, { groupJid });
    if (existing) {
      return { success: false, error: 'Grup sudah terdaftar' };
    }

    await db.insert(COLLECTION, { groupJid, name: groupName, channels: {} });
    _rebuildCache();

    logger.info({ groupJid, groupName }, '✅ Grup existing terdaftar');
    return { success: true };
  } catch (err) {
    logger.error({ groupJid, err: err.message }, '❌ Gagal daftarkan grup');
    return { success: false, error: err.message };
  }
}

// ─── Query helpers ────────────────────────────────────────────────────────

/**
 * Ambil semua grup terdaftar dari DB.
 * @returns {object[]}
 */
export function listGroups() {
  return db.find(COLLECTION, {});
}

/**
 * Cari grup berdasarkan JID.
 * @param {string} groupJid
 * @returns {object|null}
 */
export function findGroup(groupJid) {
  return db.findOne(COLLECTION, { groupJid });
}

// ─── Channel routing helpers ──────────────────────────────────────────────

/**
 * Dipakai messageHandler untuk cek apakah grup ini terdaftar sebagai input channel.
 * Return null jika grup tidak terdaftar atau bukan input channel.
 *
 * @param {string} groupJid
 * @returns {{ input: boolean, output: boolean, plugins: string[], channels: object, name: string }|null}
 */
export function getGroupChannel(groupJid) {
  const entry = _channelCache.get(groupJid);
  if (!entry) return null;
  return entry;
}

/**
 * Dipakai plugin untuk mendapatkan JID grup output berdasarkan pluginKey.
 * Mengembalikan array JID grup yang di-assign sebagai output (atau 'both') untuk plugin tersebut.
 *
 * @param {string} pluginKey
 * @returns {string[]} array groupJid
 */
export function getGroupOutput(pluginKey) {
  const result = [];
  for (const [groupJid, entry] of _channelCache.entries()) {
    const role = entry.channels?.[pluginKey];
    if (role === 'output' || role === 'both') {
      result.push(groupJid);
    }
  }
  return result;
}

/**
 * Dipakai plugin untuk mendapatkan JID grup input berdasarkan pluginKey.
 *
 * @param {string} pluginKey
 * @returns {string[]} array groupJid
 */
export function getGroupInput(pluginKey) {
  const result = [];
  for (const [groupJid, entry] of _channelCache.entries()) {
    const role = entry.channels?.[pluginKey];
    if (role === 'input' || role === 'both') {
      result.push(groupJid);
    }
  }
  return result;
}