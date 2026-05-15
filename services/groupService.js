// services/groupService.js
// Manajemen grup WhatsApp untuk bot:
//   - Buat grup baru dan tambahkan owner
//   - Hapus grup dari daftar (bot leave + hapus record)
//   - Assign grup sebagai channel input/output untuk plugin tertentu
//   - Persona per grup — dipakai saat owner chat di grup tersebut
//   - getGroupOutput(pluginKey) → dipakai plugin untuk kirim output ke grup
//   - getGroupChannel(jid)     → dipakai messageHandler untuk routing input
//   - getGroupPersona(jid)     → dipakai messageHandler untuk ambil persona grup
//
// Data disimpan di db collection "groups":
// {
//   _id: string,
//   groupJid: string,       // JID grup (@g.us)
//   name: string,           // nama grup
//   persona: string,        // persona AI khusus grup ini (opsional)
//   channels: {             // mapping plugin key → role
//     [pluginKey]: 'input' | 'output' | 'both'
//   }
// }

import db from './db.js';
import config from '../config/config.js';
//import { getTriggeredPluginByKey } from '../core/triggeredPluginHandler.js';
import logger from '../utils/logger.js';

const COLLECTION = 'groups';

// ─── In-memory cache ──────────────────────────────────────────────────────
// Map<groupJid, { input, output, plugins, channels, name, persona }>
// Di-rebuild dari DB saat init dan setiap kali ada perubahan.
let _channelCache = new Map();

function _rebuildCache() {
  _channelCache.clear();
  const all = db.find(COLLECTION, {});
  for (const group of all) {
    const channels = group.channels || {};
    const plugins = Object.keys(channels);
    const roles = Object.values(channels);
    _channelCache.set(group.groupJid, {
      input: roles.some((r) => r === 'input' || r === 'both'),
      output: roles.some((r) => r === 'output' || r === 'both'),
      plugins,
      channels,
      name: group.name,
      persona: group.persona || null,
    });
  }
  logger.debug({ size: _channelCache.size }, '🔄 Group cache rebuilt');
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
    // participants: harus @s.whatsapp.net, bukan @lid — agar tidak bad-request
    const ownerPhone = config.ownerJid;

    const result = await sock.groupCreate(groupName, [ownerPhone]);

    if (!result?.id) {
      return { success: false, error: 'Grup gagal dibuat, tidak ada ID yang dikembalikan' };
    }

    const groupJid = result.id;

    await db.insert(COLLECTION, {
      groupJid,
      name: groupName,
      persona: null,
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
    await sock.groupLeave(groupJid);
  } catch (err) {
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
 * Aturan:
 *   - Satu grup hanya boleh punya SATU plugin dengan role input/both.
 *     Jika sudah ada plugin input lain, request ditolak.
 *   - Saat plugin input/both di-assign: groupContextPrompt dari plugin
 *     otomatis disimpan sebagai persona grup (menggantikan persona lama).
 *   - Saat plugin input/both di-hapus (role none/output): persona grup
 *     dari plugin dihapus (kembali ke null).
 *
 * @param {string} groupJid
 * @param {string} pluginKey
 * @param {'input'|'output'|'both'|'none'} role
 * @returns {Promise<{ success: boolean, error?: string }>}
 */
export async function setGroupChannel(groupJid, pluginKey, role) {
  try {
    const group = db.findOne(COLLECTION, { groupJid });
    if (!group) return { success: false, error: 'Grup tidak ditemukan di daftar' };

    const channels = group.channels || {};
    const isInputRole = role === 'input' || role === 'both';

    // ── Validasi: satu plugin input per grup ────────────────────────────
    if (isInputRole) {
      const existingInputPlugin = Object.entries(channels).find(([key, r]) => {
        return key !== pluginKey && (r === 'input' || r === 'both');
      });

      if (existingInputPlugin) {
        return {
          success: false,
          error: `Grup sudah punya plugin input: "${existingInputPlugin[0]}". Hapus dulu sebelum assign plugin input baru.`,
        };
      }
    }

    // ── Update channels ──────────────────────────────────────────────────
    const previousRole = channels[pluginKey];
    const wasInput = previousRole === 'input' || previousRole === 'both';

    if (role === 'none') {
      delete channels[pluginKey];
    } else {
      channels[pluginKey] = role;
    }

    // ── Sync persona dari plugin ─────────────────────────────────────────
    // Jika role baru adalah input/both → ambil groupContextPrompt dari plugin
    // Jika role baru bukan input (output/none) dan sebelumnya adalah input → hapus persona
    let personaUpdate = {};

    if (isInputRole) {
	  const { getTriggeredPluginByKey } = await import('../core/triggeredPluginHandler.js');
      const plugin = getTriggeredPluginByKey(pluginKey);
      if (plugin?.groupContextPrompt) {
        personaUpdate = { persona: plugin.groupContextPrompt };
        logger.info({ groupJid, pluginKey }, '🎭 Persona grup diambil dari groupContextPrompt plugin');
      } else {
        logger.warn({ groupJid, pluginKey }, '⚠️ Plugin tidak punya groupContextPrompt — persona grup tidak diubah');
      }
    } else if (wasInput) {
      // Plugin sebelumnya adalah input, sekarang di-downgrade/hapus → bersihkan persona
      personaUpdate = { persona: null };
      logger.info({ groupJid, pluginKey }, '🗑️ Persona grup dari plugin dihapus (role bukan input lagi)');
    }

    await db.update(COLLECTION, { groupJid }, { channels, ...personaUpdate });
    _rebuildCache();

    logger.info({ groupJid, pluginKey, role }, '✅ Group channel diset');
    return { success: true };
  } catch (err) {
    logger.error({ groupJid, pluginKey, err: err.message }, '❌ Gagal set group channel');
    return { success: false, error: err.message };
  }
}

// ─── Set persona grup ─────────────────────────────────────────────────────
/**
 * Simpan persona khusus untuk grup tertentu.
 * Persona ini dipakai saat owner chat di grup tersebut.
 *
 * @param {string} groupJid
 * @param {string|null} persona - teks persona, null untuk hapus (kembali ke persona owner)
 * @returns {Promise<{ success: boolean, error?: string }>}
 */
export async function setGroupPersona(groupJid, persona) {
  try {
    const group = db.findOne(COLLECTION, { groupJid });
    if (!group) return { success: false, error: 'Grup tidak ditemukan di daftar' };

    await db.update(COLLECTION, { groupJid }, { persona: persona || null });
    _rebuildCache();

    logger.info({ groupJid, hasPersona: !!persona }, '✅ Group persona diset');
    return { success: true };
  } catch (err) {
    logger.error({ groupJid, err: err.message }, '❌ Gagal set group persona');
    return { success: false, error: err.message };
  }
}

// ─── Get persona grup ─────────────────────────────────────────────────────
/**
 * Ambil persona grup berdasarkan JID.
 * Return null jika grup tidak terdaftar atau belum punya persona.
 *
 * @param {string} groupJid
 * @returns {string|null}
 */
export function getGroupPersona(groupJid) {
  return _channelCache.get(groupJid)?.persona || null;
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
    if (existing) return { success: false, error: 'Grup sudah terdaftar' };

    await db.insert(COLLECTION, { groupJid, name: groupName, persona: null, channels: {} });
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
 * Dipakai messageHandler untuk cek apakah grup ini terdaftar.
 * Return null jika grup tidak terdaftar.
 *
 * @param {string} groupJid
 * @returns {{ input: boolean, output: boolean, plugins: string[], channels: object, name: string, persona: string|null }|null}
 */
export function getGroupChannel(groupJid) {
  return _channelCache.get(groupJid) || null;
}

/**
 * Dipakai plugin untuk mendapatkan JID grup output berdasarkan pluginKey.
 *
 * @param {string} pluginKey
 * @returns {string[]} array groupJid
 */
export function getGroupOutput(pluginKey) {
  const result = [];
  for (const [groupJid, entry] of _channelCache.entries()) {
    const role = entry.channels?.[pluginKey];
    if (role === 'output' || role === 'both') result.push(groupJid);
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
    if (role === 'input' || role === 'both') result.push(groupJid);
  }
  return result;
}

/**
 * Ambil semua grup yang memiliki persona (untuk warmup saat bot start).
 * @returns {{ groupJid: string, name: string, persona: string }[]}
 */
export function listGroupsWithPersona() {
  return db.find(COLLECTION, {}).filter((g) => g.persona).map((g) => ({
    groupJid: g.groupJid,
    name: g.name,
    persona: g.persona,
  }));
}