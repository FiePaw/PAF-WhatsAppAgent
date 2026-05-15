// services/db.js
// Simple JSON-based database with collection support.
// Each collection is stored as a separate JSON file in /data/<collection>.json
// Supports: insert, findOne, find, update, upsert, delete, clear
// Thread-safe via async queue per collection.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import logger from '../utils/logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');

// Ensure data directory exists
if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

// Write queue per collection to prevent concurrent write corruption
const _writeQueue = new Map(); // collection -> Promise

// ─── Internal Helpers ──────────────────────────────────────────────────────

function _collectionPath(collection) {
  return join(DATA_DIR, `${collection}.json`);
}

function _readCollection(collection) {
  const path = _collectionPath(collection);
  if (!existsSync(path)) return [];
  try {
    const raw = readFileSync(path, 'utf-8');
    return JSON.parse(raw);
  } catch {
    logger.error({ collection }, '❌ Gagal baca collection DB');
    return [];
  }
}

function _writeCollection(collection, data) {
  try {
    writeFileSync(_collectionPath(collection), JSON.stringify(data, null, 2), 'utf-8');
  } catch (err) {
    logger.error({ collection, err: err.message }, '❌ Gagal tulis collection DB');
  }
}

// Serialize writes per collection to avoid race conditions
async function _enqueue(collection, fn) {
  const prev = _writeQueue.get(collection) || Promise.resolve();
  const next = prev.then(fn);
  _writeQueue.set(collection, next.catch(() => {}));
  return next;
}

// Generate simple unique ID
function _genId() {
  return `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

// Check if document matches query object (shallow key-value match)
function _matches(doc, query) {
  for (const [key, val] of Object.entries(query)) {
    if (doc[key] !== val) return false;
  }
  return true;
}

// ─── Public API ───────────────────────────────────────────────────────────

const db = {
  /**
   * Insert satu dokumen baru ke collection.
   * Auto-assign _id dan createdAt.
   * @param {string} collection
   * @param {object} doc
   * @returns {Promise<object>} dokumen yang tersimpan (dengan _id)
   */
  async insert(collection, doc) {
    return _enqueue(collection, () => {
      const data = _readCollection(collection);
      const newDoc = { _id: _genId(), createdAt: new Date().toISOString(), ...doc };
      data.push(newDoc);
      _writeCollection(collection, data);
      logger.debug({ collection, _id: newDoc._id }, '📥 DB insert');
      return newDoc;
    });
  },

  /**
   * Cari satu dokumen yang cocok dengan query.
   * @param {string} collection
   * @param {object} query - key-value filter
   * @returns {object|null}
   */
  findOne(collection, query) {
    const data = _readCollection(collection);
    return data.find((doc) => _matches(doc, query)) || null;
  },

  /**
   * Cari semua dokumen yang cocok dengan query.
   * Query kosong {} → return semua.
   * @param {string} collection
   * @param {object} query
   * @returns {object[]}
   */
  find(collection, query = {}) {
    const data = _readCollection(collection);
    if (!Object.keys(query).length) return data;
    return data.filter((doc) => _matches(doc, query));
  },

  /**
   * Update dokumen pertama yang cocok dengan query.
   * @param {string} collection
   * @param {object} query
   * @param {object} updates - field yang di-update (merge)
   * @returns {Promise<object|null>} dokumen yang diupdate atau null
   */
  async update(collection, query, updates) {
    return _enqueue(collection, () => {
      const data = _readCollection(collection);
      const idx = data.findIndex((doc) => _matches(doc, query));
      if (idx === -1) return null;
      data[idx] = { ...data[idx], ...updates, updatedAt: new Date().toISOString() };
      _writeCollection(collection, data);
      logger.debug({ collection, _id: data[idx]._id }, '📝 DB update');
      return data[idx];
    });
  },

  /**
   * Update dokumen jika ada, insert jika tidak.
   * @param {string} collection
   * @param {object} query
   * @param {object} doc
   * @returns {Promise<object>}
   */
  async upsert(collection, query, doc) {
    return _enqueue(collection, () => {
      const data = _readCollection(collection);
      const idx = data.findIndex((d) => _matches(d, query));
      if (idx !== -1) {
        data[idx] = { ...data[idx], ...doc, updatedAt: new Date().toISOString() };
        _writeCollection(collection, data);
        return data[idx];
      } else {
        const newDoc = { _id: _genId(), createdAt: new Date().toISOString(), ...query, ...doc };
        data.push(newDoc);
        _writeCollection(collection, data);
        return newDoc;
      }
    });
  },

  /**
   * Hapus semua dokumen yang cocok dengan query.
   * @param {string} collection
   * @param {object} query
   * @returns {Promise<number>} jumlah dokumen yang dihapus
   */
  async delete(collection, query) {
    return _enqueue(collection, () => {
      const data = _readCollection(collection);
      const before = data.length;
      const filtered = data.filter((doc) => !_matches(doc, query));
      _writeCollection(collection, filtered);
      const removed = before - filtered.length;
      logger.debug({ collection, removed }, '🗑️ DB delete');
      return removed;
    });
  },

  /**
   * Hapus semua dokumen dalam collection.
   * @param {string} collection
   * @returns {Promise<void>}
   */
  async clear(collection) {
    return _enqueue(collection, () => {
      _writeCollection(collection, []);
      logger.info({ collection }, '🧹 DB collection cleared');
    });
  },

  /**
   * Hitung dokumen dalam collection.
   * @param {string} collection
   * @param {object} query
   * @returns {number}
   */
  count(collection, query = {}) {
    return this.find(collection, query).length;
  },
};

export default db;