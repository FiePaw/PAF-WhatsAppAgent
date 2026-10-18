// services/finTrackReceipt.js — baca foto struk / bukti transfer / bukti belanja dan ekstrak
// data transaksi (nominal, tanggal, kategori, keterangan) lewat vision Qwen.
// Hasil SELALU dikonfirmasi owner (!ya/!tidak) sebelum disimpan — pembacaan gambar bisa keliru.
import { isValidDate } from './calendarFormat.js';

let askOverride = null;
/** Hanya untuk pengujian: ganti fungsi pemanggil AI. */
export function __setAsk(fn) { askOverride = fn; }

const SYSTEM_PROMPT = 'Kamu adalah pembaca struk dan bukti transaksi. Balas HANYA dengan satu objek JSON valid tanpa teks lain dan tanpa markdown.';

function buildPrompt({ caption, categories, today }) {
  return (
    `Hari ini: ${today} (zona Asia/Jakarta).\n` +
    (caption ? `Keterangan dari pengirim: "${caption}"\n` : '') +
    (categories?.length ? `Kategori yang sudah dipakai owner: ${categories.join(', ')}. Pilih salah satunya jika cocok.\n` : '') +
    '\nBaca gambar (struk belanja, bukti transfer, atau tagihan) lalu ekstrak menjadi JSON dengan bentuk persis:\n' +
    '{"is_financial_document":true|false,"type":"expense|income","amount":angka rupiah TOTAL tanpa titik/koma/simbol atau null,' +
    '"date":"YYYY-MM-DD atau null","category":"satu kategori singkat","description":"nama toko/penerima + ringkasan singkat","merchant":"teks atau null"}\n' +
    'Aturan: amount = total akhir yang dibayar (bukan subtotal/kembalian); untuk struk belanja type = "expense"; ' +
    'untuk bukti transfer masuk/gaji type = "income"; jangan mengarang nilai yang tidak terlihat jelas — isi null.'
  );
}

function parseJson(raw) {
  const s = String(raw ?? '');
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(s.slice(a, b + 1)); } catch { return null; }
}

/**
 * @param {object} p
 * @param {string} p.jid            - dipakai untuk membuat session sekali pakai
 * @param {Array}  p.attachments    - attachment gambar [{ filename, data, mime_type }]
 * @param {string} [p.caption]
 * @param {string[]} [p.categories] - kategori yang sudah ada (agar konsisten)
 * @param {string} p.today          - 'YYYY-MM-DD' (WIB)
 * @returns {Promise<{ type: string, amount: number, category: string, date: string, description: string }|null>}
 *          null jika bukan dokumen keuangan / nominal tidak terbaca / AI gagal.
 */
export async function extractReceipt({ jid, attachments, caption, categories, today }) {
  const sessionJid = `finReceipt:${jid}:${Date.now()}`;
  let raw;
  try {
    if (askOverride) {
      raw = await askOverride({ jid: sessionJid, userText: buildPrompt({ caption, categories, today }), systemPrompt: SYSTEM_PROMPT, attachments });
    } else {
      const { askAI } = await import('./aiService.js');
      raw = await askAI({
        jid: sessionJid,
        userText: buildPrompt({ caption, categories, today }),
        systemPrompt: SYSTEM_PROMPT,
        thinkMode: 'fast',
        attachments,
        model: 'qwen', // vision selalu Qwen
        forceNew: true,
        useMemory: false,
      });
    }
  } finally {
    try { (await import('./sessionStore.js')).sessionStore?.delete(sessionJid); } catch { /* abaikan */ }
  }

  const j = parseJson(raw);
  if (!j || j.is_financial_document === false) return null;

  const amount = Math.round(Number(j.amount));
  if (!Number.isFinite(amount) || amount <= 0) return null;

  return {
    type: j.type === 'income' ? 'income' : 'expense',
    amount,
    category: typeof j.category === 'string' && j.category.trim() ? j.category.trim() : 'Lainnya',
    date: isValidDate(j.date) && j.date <= today ? j.date : today,
    description: typeof j.description === 'string' ? j.description.trim().slice(0, 120) : '',
  };
}
