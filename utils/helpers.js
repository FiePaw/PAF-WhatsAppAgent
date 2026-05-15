// utils/helpers.js
import config from '../config/config.js';

/**
 * Cek apakah sender adalah owner
 * @param {string} jid - sender JID (e.g. 6281234567890@s.whatsapp.net)
 * @returns {boolean}
 */
export function isOwner(jid) {
  if (!jid) return false;

  // 1. Cocokkan LID owner (dari .env OWNER_LID atau runtime resolve)
  //    LID adalah angka acak WhatsApp, tidak boleh di-compare dengan nomor HP
  if (config.ownerLid && jid === config.ownerLid) return true;

  // 2. Cocokkan @s.whatsapp.net (nomor HP biasa — untuk WA versi lama)
  if (jid === config.ownerJid) return true;

  // 3. Fallback number-only match — HANYA untuk domain @s.whatsapp.net
  //    JANGAN bandingkan angka dari @lid karena LID != nomor HP
  if (jid.endsWith('@s.whatsapp.net')) {
    const num = jid.split('@')[0].replace(/\D/g, '');
    const ownerNum = config.ownerNumber.replace(/\D/g, '');
    if (num === ownerNum) return true;
  }

  return false;
}

/**
 * Ekstrak nomor dari JID
 * @param {string} jid
 * @returns {string}
 */
export function jidToNumber(jid) {
  return jid.split('@')[0];
}

/**
 * Cek apakah pesan adalah command (diawali prefix)
 * @param {string} text
 * @returns {boolean}
 */
export function isCommand(text) {
  return text?.startsWith(config.botPrefix);
}

/**
 * Parse command dan argumen dari teks
 * @param {string} text
 * @returns {{ command: string, args: string[], fullArgs: string }}
 */
export function parseCommand(text) {
  const withoutPrefix = text.slice(config.botPrefix.length).trim();
  const [command, ...args] = withoutPrefix.split(/\s+/);
  return {
    command: command.toLowerCase(),
    args,
    fullArgs: args.join(' '),
  };
}

/**
 * Format uptime ke string yang readable
 * @param {number} ms
 * @returns {string}
 */
export function formatUptime(ms) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  if (d > 0) return `${d}h ${h % 24}j ${m % 60}m`;
  if (h > 0) return `${h}j ${m % 60}m ${s % 60}d`;
  if (m > 0) return `${m}m ${s % 60}d`;
  return `${s}d`;
}
