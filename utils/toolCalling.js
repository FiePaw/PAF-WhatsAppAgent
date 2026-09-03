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
 * Ekstrak tool_call PERTAMA dari sebuah message object hasil response AI.
 * Return null jika tidak ada tool_calls (model memilih tidak memanggil tool).
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

  let args = {};
  try {
    args = JSON.parse(call.function.arguments || '{}');
  } catch {
    args = {};
  }

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
      let args = {};
      try {
        args = JSON.parse(call.function.arguments || '{}');
      } catch {
        args = {};
      }
      return { name, args };
    })
    .filter(Boolean);
}
