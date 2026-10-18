// services/finTrackClient.js — klien HTTP ke FinTrack (/ext/*). ESM.
// Env (opsional, .env bot): FINTRACK_API_URL, FINTRACK_API_KEY.
// Jika env tidak diisi, dipakai nilai default lama (kompatibel dengan versi sebelumnya).
// Env dibaca saat dipanggil (bukan saat modul dimuat) agar tidak tergantung urutan load dotenv.

const TIMEOUT_MS = 10000;

const baseUrl = () => (process.env.FINTRACK_API_URL || 'http://20.239.192.10:9550').replace(/\/+$/, '');
const apiKey = () => process.env.FINTRACK_API_KEY || 'fintrack-ext-key';

export class FinTrackError extends Error {
  /**
   * @param {string} message
   * @param {number} status  - HTTP status, 0 = gagal jaringan/timeout
   * @param {*} body         - body JSON error dari server (null jika bukan JSON)
   */
  constructor(message, status = 0, body = null) {
    super(message);
    this.name = 'FinTrackError';
    this.status = status;
    this.body = body;
  }
}

/** Request mentah ke FinTrack. Signature sama dengan helper lama: ft(method, path, body). */
export async function ft(method, path, body = null, { timeoutMs = TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(`${baseUrl()}${path}`, {
      method,
      headers: {
        'X-API-Key': apiKey(),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
  } catch (err) {
    throw new FinTrackError(
      err.name === 'AbortError'
        ? 'FinTrack tidak merespons (timeout)'
        : `Tidak dapat menghubungi FinTrack (${err.cause?.code || err.message})`,
      0
    );
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* bukan JSON */ }

  if (!res.ok) {
    throw new FinTrackError((data && data.error) || `HTTP ${res.status}`, res.status, data);
  }
  return data;
}

// Field yang dikirim ke FinTrack per resource (sesuai payload POST yang sudah ada).
const FIELDS = {
  transactions: ['type', 'amount', 'category', 'date', 'description'],
  budgets: ['category', 'limit'],
  bills: ['name', 'amount', 'due_day', 'category', 'autodebit', 'notes'],
  investments: ['code', 'name', 'shares', 'buy_price', 'buy_date', 'notes'],
};

function pick(obj, keys) {
  const out = {};
  for (const k of keys) if (obj && obj[k] !== undefined) out[k] = obj[k];
  return out;
}

export const list = (resource) => ft('GET', `/ext/${resource}`);
export const create = (resource, data) => ft('POST', `/ext/${resource}`, pick(data, FIELDS[resource]));
export const remove = (resource, id) => ft('DELETE', `/ext/${resource}/${id}`);

// PUT dianggap "tidak didukung server" jika 405/501, atau 404 dengan body BUKAN JSON
// (route tidak ada). 404 dengan body JSON = data tidak ditemukan → error asli.
function putUnsupported(err) {
  return err instanceof FinTrackError && (err.status === 405 || err.status === 501 || (err.status === 404 && err.body === null));
}

/**
 * Ubah satu data. Urutan:
 *   1. PUT /ext/<resource>/<id> dengan data lama + perubahan.
 *   2. Jika server tidak mendukung PUT → fallback: BUAT data baru dulu, baru hapus data lama
 *      (create-then-delete, supaya kalau gagal di tengah tidak ada data yang hilang).
 *
 * @param {string} resource - transactions | budgets | bills | investments
 * @param {object} current  - objek data saat ini (harus punya id)
 * @param {object} patch    - field yang diubah
 * @returns {Promise<{ data: *, mode: 'put'|'recreate' }>}
 */
export async function update(resource, current, patch) {
  const merged = { ...pick(current, FIELDS[resource]), ...pick(patch, FIELDS[resource]) };
  const putBody = resource === 'bills' && current.active !== undefined ? { ...merged, active: current.active } : merged;

  try {
    const data = await ft('PUT', `/ext/${resource}/${current.id}`, putBody);
    return { data, mode: 'put' };
  } catch (err) {
    if (!putUnsupported(err)) throw err;
  }

  const created = await create(resource, merged);
  try {
    await remove(resource, current.id);
  } catch (err) {
    throw new FinTrackError(
      `Data baru sudah dibuat, tetapi data lama gagal dihapus (${err.message}). Cek duplikat dan hapus yang lama secara manual.`,
      err.status || 0
    );
  }
  return { data: created, mode: 'recreate' };
}