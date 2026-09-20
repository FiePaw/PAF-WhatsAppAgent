// utils/toolCalling.js
// Helper kecil untuk membangun & mem-parse "tools" (OpenAI function-calling
// shape) yang sekarang didukung PAF-Model gateway di kedua backend
// (lihat API_USAGE.md §9). Dipakai untuk menggantikan pola lama "suruh AI
// balas raw JSON di tengah teks lalu regex/JSON.parse manual" — sekarang
// gateway sendiri yang menjamin bentuk keluaran via system prompt khusus
// "pure JSON API endpoint" dan mengembalikannya sebagai `message.tool_calls`
// yang sudah terstruktur, bukan teks bebas yang harus kita bersihkan sendiri.
//
// Dipakai oleh: aiService.js (askAITool), intentSessionService.js,
// botBrain.js, plugins/scheduled/economicNews.js.

import logger from './logger.js';

/**
 * Bangun satu definisi tool dalam format OpenAI function-calling.
 *
 * @param {string} name          - nama function, harus unik dalam satu request
 * @param {string} description   - deskripsi untuk model, jelaskan kapan tool ini dipakai
 * @param {object} parameters    - JSON Schema (type: 'object', properties, required)
 * @returns {{ type: 'function', function: { name, description, parameters } }}
 */
export function buildFunctionTool(name, description, parameters) {
  return {
    type: 'function',
    function: {
      name,
      description: description || '',
      parameters: parameters || { type: 'object', properties: {}, additionalProperties: true },
    },
  };
}

/**
 * [Fix myFinance "params: {}", babak 2] Parse `arguments` dari satu
 * tool_call. Gateway PAF-Model (browser-automation, BUKAN API OpenAI
 * resmi) TIDAK KONSISTEN soal bentuk `arguments`:
 *   - Sesuai spek OpenAI asli: `arguments` harus berupa STRING JSON-encoded
 *     (mis. `'{"action":"addTransaction"}'`) — ini yang diasumsikan kode
 *     lama, makanya selalu di-`JSON.parse()`.
 *   - NYATANYA (lihat log produksi): gateway ini kadang mengembalikan
 *     `arguments` sebagai OBJECT JS MENTAH langsung, bukan string. Saat itu
 *     terjadi, `JSON.parse(object)` SELALU gagal — JS meng-coerce object
 *     ke string `"[object Object]"` dulu sebelum di-parse, bukan membaca
 *     isinya — sehingga args selalu jatuh ke fallback `{}` walau modelnya
 *     sebenarnya sudah benar mengisi semua field.
 *
 * Fungsi ini menangani KEDUA bentuk: string → JSON.parse seperti biasa;
 * object → dipakai langsung tanpa parsing.
 *
 * @param {string|object|null|undefined} rawArgs
 * @param {string} name - nama tool, untuk logging
 * @returns {object}
 */
function parseToolArguments(rawArgs, name) {
  if (rawArgs == null) return {};

  // Bentuk object mentah (tidak sesuai spek OpenAI, tapi nyata terjadi di
  // gateway ini) — pakai langsung, JANGAN di-JSON.parse (pasti gagal).
  if (typeof rawArgs === 'object') {
    logger.debug({ name }, 'ℹ️ extractToolCall: arguments tool_call berupa object mentah (bukan JSON string) — dipakai langsung');
    return rawArgs;
  }

  // Bentuk sesuai spek OpenAI: string JSON-encoded
  if (typeof rawArgs === 'string') {
    try {
      return JSON.parse(rawArgs || '{}');
    } catch (err) {
      logger.warn(
        { name, rawArgs, err: err.message },
        '⚠️ extractToolCall: gagal parse arguments (string) tool_call, fallback ke {} — model mungkin mengembalikan JSON tidak valid'
      );
      return {};
    }
  }

  logger.warn({ name, rawArgsType: typeof rawArgs }, '⚠️ extractToolCall: tipe arguments tool_call tidak dikenali, fallback ke {}');
  return {};
}

/**
 * Ekstrak tool_call PERTAMA dari sebuah message object hasil response AI.
 * Return null jika tidak ada tool_calls (model memilih tidak memanggil tool).
 *
 * [Fix myFinance "params: {}"] Lihat parseToolArguments() di atas — dulu
 * kegagalan JSON.parse (termasuk kasus arguments sudah berupa object)
 * ditelan diam-diam, fallback ke `{}` tanpa jejak sama sekali. Sekarang
 * DUA bentuk `arguments` (string atau object) ditangani dengan benar, dan
 * kegagalan yang genuinely tidak bisa di-parse tetap di-log sebagai warning.
 *
 * @param {object} message - `choices[0].message` dari response gateway
 * @returns {{ name: string, args: object } | null}
 */
export function extractToolCall(message) {
  const toolCalls = message?.tool_calls;
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) return null;

  const call = toolCalls[0];
  const name = call?.function?.name ?? null;
  if (!name) return null;

  const args = parseToolArguments(call.function.arguments, name);

  return { name, args };
}

/**
 * Ekstrak SEMUA tool_calls dari message (dipakai jika model boleh memanggil
 * lebih dari satu tool dalam satu balasan — saat ini tidak dipakai di mana
 * pun tapi disediakan untuk masa depan).
 *
 * @param {object} message
 * @returns {{ name: string, args: object }[]}
 */
export function extractAllToolCalls(message) {
  const toolCalls = message?.tool_calls;
  if (!Array.isArray(toolCalls)) return [];

  return toolCalls
    .map((call) => {
      const name = call?.function?.name ?? null;
      if (!name) return null;
      const args = parseToolArguments(call.function.arguments, name);
      return { name, args };
    })
    .filter(Boolean);
}
