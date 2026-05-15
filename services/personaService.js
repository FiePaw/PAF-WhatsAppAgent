// services/personaService.js
// Manage persona per user dari config/persona.json
// Hot-reload: persona.json bisa diedit tanpa restart bot
//
// Struktur persona.json yang didukung:
//
//   Format BARU (object dengan prompt + model opsional):
//     "owner":   { "prompt": "...", "model": "account1" }
//     "default": { "prompt": "..." }
//     "users":   { "628xxx": { "prompt": "...", "model": "account6" } }
//     "intentSession": { "model": "account2" }  ← model khusus untuk intent session
//
//   Format LAMA (string langsung) — tetap kompatibel:
//     "owner":   "prompt string..."
//     "default": "prompt string..."
//     "users":   { "628xxx": "prompt string..." }
//
// getPersona()      → { prompt: string, model: string|null }
// getPersonaPrompt()→ string (untuk backward compat)
// getPersonaModel() → string|null

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

// ─── Helper: normalisasi entry persona ke { prompt, model } ──────────────
// Entry bisa berupa string (format lama) atau object { prompt, model? }
function normalizeEntry(entry) {
  if (!entry) return { prompt: '', model: null };
  if (typeof entry === 'string') return { prompt: entry, model: null };
  return {
    prompt: entry.prompt || '',
    model: entry.model || null,
  };
}

// ─── Resolve entry mentah dari persona.json untuk senderJid ──────────────
function resolveRawEntry(senderJid, owner) {
  const number = jidToNumber(senderJid);
  const lidKey = senderJid.endsWith('@lid') ? senderJid : null;
  const users = personaData.users || {};

  // 1. Persona spesifik user
  if (users[number]) return users[number];
  if (lidKey && users[lidKey]) return users[lidKey];

  // 2. Owner persona
  if (owner && personaData.owner) return personaData.owner;

  // 3. Default
  return personaData.default || '';
}

// ─── Public API ───────────────────────────────────────────────────────────

/**
 * Ambil persona lengkap { prompt, model } untuk sender tertentu.
 * model null berarti gunakan fallback dari config (AI_MODEL/.env).
 *
 * @param {string} senderJid
 * @param {boolean} owner
 * @returns {{ prompt: string, model: string|null }}
 */
export function getPersona(senderJid, owner) {
  return normalizeEntry(resolveRawEntry(senderJid, owner));
}

/**
 * Ambil HANYA prompt string (backward-compat untuk kode yang masih expect string).
 *
 * @param {string} senderJid
 * @param {boolean} owner
 * @returns {string}
 */
export function getPersonaPrompt(senderJid, owner) {
  return getPersona(senderJid, owner).prompt;
}

/**
 * Ambil model khusus untuk intent session (key "intentSession" di persona.json).
 * Return null jika tidak diset — aiService akan fallback ke config.ai.model.
 *
 * @returns {string|null}
 */
export function getIntentSessionModel() {
  const entry = personaData.intentSession;
  if (!entry) return null;
  if (typeof entry === 'string') return null; // tidak ada model jika format lama
  return entry.model || null;
}

/**
 * Simpan / update persona untuk satu user ke persona.json.
 * Jika entry lama sudah object, pertahankan model-nya.
 *
 * @param {string} senderJid
 * @param {string} promptText
 * @param {string|null} [model]
 */
export function setPersona(senderJid, promptText, model = null) {
  const number = jidToNumber(senderJid);
  if (!personaData.users) personaData.users = {};

  const existing = personaData.users[number];
  const existingModel = (existing && typeof existing === 'object') ? existing.model : null;
  const finalModel = model ?? existingModel;

  personaData.users[number] = finalModel
    ? { prompt: promptText, model: finalModel }
    : { prompt: promptText };

  savePersonaFile();
  logger.info({ number, model: finalModel || '(default)' }, '✅ Persona user diperbarui');
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
 * Update persona global (owner atau default).
 * Model opsional — jika tidak diisi, model lama dipertahankan.
 *
 * @param {'owner'|'default'} key
 * @param {string} promptText
 * @param {string|null} [model]
 */
export function setGlobalPersona(key, promptText, model = null) {
  if (key !== 'owner' && key !== 'default') return;

  const existing = personaData[key];
  const existingModel = (existing && typeof existing === 'object') ? existing.model : null;
  const finalModel = model ?? existingModel;

  personaData[key] = finalModel
    ? { prompt: promptText, model: finalModel }
    : { prompt: promptText };

  savePersonaFile();
  logger.info({ key, model: finalModel || '(default)' }, `✅ Persona global '${key}' diperbarui`);
}

/**
 * List semua persona yang ada (menampilkan prompt + model)
 */
export function listPersonas() {
  const fmt = (entry) => {
    const { prompt, model } = normalizeEntry(entry);
    return model ? `[${model}] ${prompt}` : prompt;
  };

  const users = personaData.users || {};
  const formatted = {};
  for (const [key, val] of Object.entries(users)) {
    formatted[key] = fmt(val);
  }

  return {
    owner: fmt(personaData.owner) || '(tidak diset)',
    default: fmt(personaData.default) || '(tidak diset)',
    intentSession: personaData.intentSession?.model
      ? `model: ${personaData.intentSession.model}`
      : '(model default)',
    users: formatted,
  };
}

function savePersonaFile() {
  try {
    writeFileSync(PERSONA_PATH, JSON.stringify(personaData, null, 2), 'utf-8');
  } catch (err) {
    logger.error({ err: err.message }, '❌ Gagal simpan persona.json');
  }
}