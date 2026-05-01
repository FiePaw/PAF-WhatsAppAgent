// services/personaService.js
// Manage persona per user dari config/persona.json
// Hot-reload: persona.json bisa diedit tanpa restart bot
import { readFileSync, watchFile, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { isOwner, jidToNumber } from '../utils/helpers.js';
import logger from '../utils/logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PERSONA_PATH = join(__dirname, '..', 'config', 'persona.json');

let personaData = loadPersonaFile();

// Hot-reload: auto-reload saat persona.json diubah
watchFile(PERSONA_PATH, { interval: 2000 }, () => {
  personaData = loadPersonaFile();
  logger.info('🔄 persona.json di-reload');
});

function loadPersonaFile() {
  try {
    const raw = readFileSync(PERSONA_PATH, 'utf-8');
    return JSON.parse(raw);
  } catch (err) {
    logger.error({ err: err.message }, '❌ Gagal baca persona.json');
    return { owner: '', default: '', users: {} };
  }
}

/**
 * Ambil persona untuk sender tertentu.
 * Prioritas:
 *   1. persona spesifik user di users[nomor] atau users[lid]
 *   2. persona 'owner' jika sender adalah owner
 *   3. persona 'default' sebagai fallback
 *
 * @param {string} senderJid - JID sender (format @s.whatsapp.net atau @lid)
 * @param {boolean} owner    - apakah sender adalah owner
 * @returns {string}
 */
export function getPersona(senderJid, owner) {
  const number = jidToNumber(senderJid);           // angka saja
  const lidKey = senderJid.endsWith('@lid')
    ? senderJid                                     // "225545979723871@lid"
    : null;

  const users = personaData.users || {};

  // 1. Cek persona spesifik: cocokkan nomor atau LID
  if (users[number]) return users[number];
  if (lidKey && users[lidKey]) return users[lidKey];

  // 2. Owner persona
  if (owner && personaData.owner) return personaData.owner;

  // 3. Default
  return personaData.default || '';
}

/**
 * Simpan / update persona untuk satu user ke persona.json
 * @param {string} senderJid
 * @param {string} persona
 */
export function setPersona(senderJid, persona) {
  const number = jidToNumber(senderJid);
  if (!personaData.users) personaData.users = {};
  personaData.users[number] = persona;
  savePersonaFile();
  logger.info({ number }, '✅ Persona user diperbarui');
}

/**
 * Hapus persona spesifik user (kembali ke default)
 * @param {string} senderJid
 */
export function deletePersona(senderJid) {
  const number = jidToNumber(senderJid);
  if (personaData.users?.[number]) {
    delete personaData.users[number];
    savePersonaFile();
    logger.info({ number }, '🗑️ Persona user dihapus');
    return true;
  }
  return false;
}

/**
 * Update persona global (owner atau default)
 * @param {'owner'|'default'} key
 * @param {string} persona
 */
export function setGlobalPersona(key, persona) {
  if (key !== 'owner' && key !== 'default') return;
  personaData[key] = persona;
  savePersonaFile();
  logger.info({ key }, `✅ Persona global '${key}' diperbarui`);
}

/**
 * List semua persona yang ada
 */
export function listPersonas() {
  return {
    owner: personaData.owner || '(tidak diset)',
    default: personaData.default || '(tidak diset)',
    users: personaData.users || {},
  };
}

function savePersonaFile() {
  try {
    writeFileSync(PERSONA_PATH, JSON.stringify(personaData, null, 2), 'utf-8');
  } catch (err) {
    logger.error({ err: err.message }, '❌ Gagal simpan persona.json');
  }
}