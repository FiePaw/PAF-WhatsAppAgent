// plugins/scheduled/economicNews.js
// Scheduled plugin: kirim ringkasan berita ekonomi global setiap 4 jam.
// Qwen mengembalikan JSON terstruktur → diformat menjadi pesan WhatsApp yang rapi.
//
// Setup grup: !group channel <groupJid> economicNews output/both
// Tanpa grup tertaut: berita dikirim langsung ke DM owner

import { askAI } from '../../services/aiService.js';
import { getGroupOutput } from '../../services/groupService.js';
import config from '../../config/config.js';
import logger from '../../utils/logger.js';

// ─── Prompt untuk Qwen ────────────────────────────────────────────────────
// Qwen diminta return JSON murni — tidak ada teks lain di luar JSON.
// Field "hot" dinilai oleh Qwen; sumber HANYA dalam format markdown link [nama](url)
// URL diekstrak langsung tanpa rproses, dijadikan clickable link di pesan final.
const NEWS_PROMPT = `Kamu adalah analis ekonomi profesional. Tugasmu adalah memberikan ringkasan berita ekonomi terkini dalam format JSON. Balas HANYA dengan raw JSON tanpa markdown, tanpa backtick, tanpa penjelasan apapun di luar JSON.

Format JSON yang harus kamu kembalikan:
{
  "datetime": "<tanggal dan waktu sekarang di bekasi, indonesia, format: DD MMM YYYY HH:mm WIB>",
  "global": [
    { "headline": "<judul singkat>", "summary": "<1-3 kalimat ringkasan. Sertakan minimal satu citation sumber di akhir HANYA dalam format markdown [nama sumber](url lengkap)>", "hot": <true/false> },
    { "headline": "<judul singkat>", "summary": "<ringkasan dengan citation [nama sumber](url)>", "hot": <true/false> },
    { "headline": "<judul singkat>", "summary": "<ringkasan dengan citation [nama sumber](url)>", "hot": <true/false> },
    { "headline": "<judul singkat>", "summary": "<ringkasan dengan citation [nama sumber](url)>", "hot": <true/false> },
    { "headline": "<judul singkat>", "summary": "<ringkasan dengan citation [nama sumber](url)>", "hot": <true/false> }
  ],
  "economicCalendar": [
    { "event": "<nama event ekonomi penting>", "country": "<kode negara: US, EUR, GBP, JPY, dll>", "time": "<waktu WIB (Waktu Indonesia Barat) di daerah bekasi dengan format DD MMM YYYY HH:mm WIB>", "forecast": "<prediksi/ekspektasi nilai>", "previous": "<nilai sebelumnya>", "impact": "<HIGH/MEDIUM/LOW>" }
  ],
  "indonesia": [
    { "headline": "<judul singkat>", "summary": "<1-3 kalimat ringkasan. Sertakan minimal satu citation sumber di akhir HANYA dalam format markdown [nama sumber](url lengkap)>", "hot": <true/false> },
    { "headline": "<judul singkat>", "summary": "<ringkasan dengan citation [nama sumber](url)>", "hot": <true/false> },
    { "headline": "<judul singkat>", "summary": "<ringkasan dengan citation [nama sumber](url)>", "hot": <true/false> },
    { "headline": "<judul singkat>", "summary": "<ringkasan dengan citation [nama sumber](url)>", "hot": <true/false> },
    { "headline": "<judul singkat>", "summary": "<ringkasan dengan citation [nama sumber](url)>", "hot": <true/false> }
  ]
}

Instruksi GLOBAL (5 berita):
- Pilih berita ekonomi paling penting dari seluruh dunia
- Cakup: pasar keuangan, cryptocurrency, commodity, geopolitik ekonomi, kebijakan central bank, merger & akuisisi besar-besaran
- Sumber Utama: Twitter/X, Instagram, TikTok dari akun resmi ekonomi/keuangan global (misal: @WSJ, @Bloomberg, @Reuters, @FT, @CNBC, @MarketWatch) dan sumber berita online terpercaya lainnya
- Sumber: Reuters, Bloomberg, WSJ, Financial Times, CNBC, MarketWatch, dan sumber terpercaya lainnya

Instruksi ECONOMIC CALENDAR (diekstrak dari ForexFactory, TradingView, atau sumber sejenis):
- Ambil 5 event ekonomi paling penting yang akan/sedang terjadi (NFP, CPI, PPI, Interest Rate Decision, GDP, dll)
- Negara: US, EU, Inggris, Jepang, China, atau negara dengan dampak global besar
- Waktu: dalam format WIB daerah bekasi di Indonesia
- Impact: HIGH untuk acara pemecah pasar, MEDIUM untuk moderate, LOW untuk minor

Instruksi INDONESIA (5 berita):
- Fokus pada ekonomi Indonesia, IHSG, rupiah, inflasi, BI policy, sektor industri lokal
- Cakup: pasar modal, perbankan, pertanian, manufaktur, trade, investasi asing, dan teknologi
- Sumber: Tempo, Kompas, Bisnis, Detik, Antara, Katadata, Kontan, atau mediasosial seperti Twitter/X, Instagram, TikTok dari akun resmi ekonomi/keuangan Indonesia

Aturan field "hot": Tandai true hanya jika berita tersebut benar-benar luar biasa, misalnya: kolaps pasar mendadak, kebijakan darurat pemerintah, bencana ekonomi, rekor bersejarah, atau peristiwa yang jarang terjadi dalam dekade. Berita rutin tetap false.

Aturan WAJIB:
- Setiap summary HARUS punya minimal satu link sumber tanpa markdown-text cukup berikan url lengkap dengan format plain text.
- Link harus berupa plain text lengkap dengan protokol https://
- pastikan link nya valid dan bisa diakses, bukan link yang rusak atau salah format
- JSON harus valid: gunakan double quotes, escape karakter khusus, hindari line break di tengah value
- Jangan ulangi berita dari update sebelumnya
- JANGAN MENGGUNAKAN MARKDOWN (qwen-markdown-text) APAPUN CUKUP PLAIN TEXT.

Gunakan bahasa Indonesia yang singkat, jelas, dan mudah dipahami.`;

// ─── Konstanta ────────────────────────────────────────────────────────────
// Regex untuk markdown link HANYA: [label](url)
// Capture: [1] = label, [2] = full URL
const CITATION_RE = /\[([^\]]*)\]\((https?:\/\/[^)]*)\)/g;



// ─── Sanitasi rawContent sebelum JSON.parse ───────────────────────────────
/**
 * Bersihkan citation dari string value JSON:
 * - Ekstrak URL dari markdown link [label](url)
 * - Simpan URL list sebagai marker <<url1|url2>> di akhir value
 * - Hapus label markdown link dan control characters agar JSON.parse() valid
 *
 * @param {string} raw
 * @returns {string}
 */
function sanitizeRawJson(raw) {
  // Strip markdown fences jika ada
  let s = raw.replace(/```json|```/gi, '').trim();

  // Proses setiap JSON string value secara terpisah
  s = s.replace(/"((?:[^"\\]|\\.)*)"/g, (match, inner) => {
    const urlSet = new Set();

    // Extract URLs dari markdown link, ganti link dengan spasi
    let c = inner.replace(CITATION_RE, (full, label, url) => {
      if (url && url.startsWith('http')) {
        urlSet.add(url);
      }
      return ' '; // Ganti seluruh link dengan spasi
    });

    // Embed daftar URL sebagai marker <<url1|url2>> di akhir value
    if (urlSet.size > 0) {
      c = c.trimEnd() + ` <<${[...urlSet].join('|')}>>`;
    }

    // Bersihkan newline, tab, dan control characters tidak valid dalam JSON string
    c = c.replace(/[\n\r\t]/g, ' ')
         .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
         .replace(/ {2,}/g, ' ')
         .trim();

    return `"${c}"`;
  });

  return s;
}

// ─── Ekstrak URL dari marker <<...>> dalam summary ─────────────────────────
/**
 * @param {string} text - summary yang masih mengandung marker <<url1|url2>>
 * @returns {string[]}
 */
function extractSourceUrls(text) {
  const m = text.match(/<<([^>]+)>>/);
  if (!m) return [];
  return [...new Set(m[1].split('|').map(s => s.trim()).filter(Boolean))];
}

/**
 * Hapus marker <<...>> dari teks agar summary bersih saat dikirim.
 * @param {string} text
 * @returns {string}
 */
function stripSourceMarker(text) {
  return text.replace(/\s*<<[^>]*>>/, '').replace(/\s{2,}/g, ' ').trim();
}

// ─── Format JSON → pesan WhatsApp ────────────────────────────────────────
/**
 * Ubah JSON berita dari Qwen menjadi teks siap kirim ke WhatsApp.
 * - URL diekstrak dari marker <<...>> yang ditanam saat sanitasi.
 * - Ditampilkan sebagai clickable link: [🔗 Sumber](url)
 * - Item dengan hot: true dibold seluruhnya dan diberi label 🔥.
 * @param {object} data - parsed JSON dari Qwen (summary masih mengandung marker URL)
 * @returns {string}
 */
function formatNewsMessage(data) {
  const lines = [];

  lines.push(`📊 *Update Ekonomi*`);
  lines.push(`🕐 ${data.datetime}`);
  lines.push('');

  lines.push('🌍 *Global*');
  for (const item of data.global) {
    const sourceUrls = extractSourceUrls(item.summary);
    const cleanSummary = stripSourceMarker(item.summary);
    if (item.hot) {
      lines.push(`🔥 *[HOTNEWS]* ``${item.headline}`` `);
      lines.push(`  *${cleanSummary}*`);
    } else {
      lines.push(`• *${item.headline}*`);
      lines.push(`  ${cleanSummary}`);
    }
    if (sourceUrls.length > 0) {
      const links = sourceUrls.map((url, idx) => `[🔗 Sumber ${idx + 1}](${url})`).join(' ');
      lines.push(`  ${links}`);
    }
  }

  lines.push('');

  // ── Economic Calendar ──
  if (Array.isArray(data.economicCalendar) && data.economicCalendar.length > 0) {
    lines.push('📅 *Economic Calendar - Event Penting*');
    for (const event of data.economicCalendar) {
      const impactEmoji = event.impact === 'HIGH' ? '🔴' : event.impact === 'MEDIUM' ? '🟠' : '🟡';
      lines.push(`${impactEmoji} *${event.event}* (${event.country})`);
      lines.push(`  ⏰ ${event.time}`);
      lines.push(`  📊 Forecast: ${event.forecast} | Prior: ${event.previous}`);
    }
    lines.push('');
  }

  lines.push('🇮🇩 *Indonesia*');
  for (const item of data.indonesia) {
    const sourceUrls = extractSourceUrls(item.summary);
    const cleanSummary = stripSourceMarker(item.summary);
    if (item.hot) {
      lines.push(`🔥 *[HOTNEWS]* ``${item.headline}```);
      lines.push(`  *${cleanSummary}*`);
    } else {
      lines.push(`• *${item.headline}*`);
      lines.push(`  ${cleanSummary}`);
    }
    if (sourceUrls.length > 0) {
      const links = sourceUrls.map((url, idx) => `[🔗 Sumber ${idx + 1}](${url})`).join(' ');
      lines.push(`  ${links}`);
    }
  }

  lines.push('');
  lines.push('_Sumber: analisis AI berdasarkan data terkini_');

  return lines.join('\n');
}

// ─── Handler utama ────────────────────────────────────────────────────────
async function sendEconomicNews() {
  logger.info('📰 Menjalankan scheduled economic news...');

  // Ambil berita dari Qwen dalam format JSON
  let rawContent;
  try {
    rawContent = await askAI({
      jid: 'scheduled:economicNews',
      userText: 'Berikan update berita ekonomi sekarang. Note: dengan data terupdate dari sumber utama yaitu tiktok, instagram, x.com, dan sumber berita online lainnya. jangan memberikan news sebelumnya yang sudah pernah kamu berikan. pastikan kirimkan sesuai format!',
      systemPrompt: NEWS_PROMPT,
      thinkMode: 'thinking',
    });
  } catch (err) {
    logger.error({ err: err.message }, '❌ Gagal ambil berita ekonomi dari AI');
    return;
  }

  if (!rawContent) {
    logger.warn('⚠️ AI tidak mengembalikan konten berita');
    return;
  }

  // Deteksi dini: jika response tidak dimulai dengan '{', Qwen mengembalikan
  // teks narasi bukan JSON — langsung retry dengan prompt yang lebih tegas.
  if (!rawContent.trimStart().startsWith('{')) {
    logger.warn('⚠️ Response bukan JSON, retry dengan prompt tegas...');
    try {
      rawContent = await askAI({
        jid: 'scheduled:economicNews',
        userText: 'PERINTAH ULANG: Balas HANYA dengan raw JSON sesuai format yang sudah ditentukan. DILARANG menulis teks, narasi, atau penjelasan apapun di luar JSON. Mulai langsung dengan karakter { dan akhiri dengan }.',
        systemPrompt: NEWS_PROMPT,
        thinkMode: 'thinking',
      });
    } catch (err) {
      logger.error({ err: err.message }, '❌ Gagal ambil berita ekonomi dari AI (retry)');
      return;
    }
    if (!rawContent || !rawContent.trimStart().startsWith('{')) {
      logger.error({ raw: rawContent?.slice(0, 100) }, '❌ AI tetap tidak mengembalikan JSON setelah retry, skip');
      return;
    }
  }

  // Parse JSON dari Qwen
  let newsData;
  try {
    const cleaned = sanitizeRawJson(rawContent);
    newsData = JSON.parse(cleaned);
  } catch (err) {
    logger.error({ err: err.message, raw: rawContent.slice(0, 300) }, '❌ Gagal parse JSON berita dari AI');
    return;
  }

  // Validasi field wajib
  if (!newsData.datetime || !Array.isArray(newsData.global) || !Array.isArray(newsData.indonesia)) {
    logger.error({ newsData }, '❌ Struktur JSON berita tidak valid');
    return;
  }
  
  // Validasi jumlah item (minimal 5 untuk global & indonesia)
  if (newsData.global.length < 5 || newsData.indonesia.length < 5) {
    logger.warn({ 
      globalCount: newsData.global.length, 
      indonesiaCount: newsData.indonesia.length 
    }, '⚠️ Jumlah berita kurang dari 5, lanjutkan saja');
  }
  
  // economicCalendar opsional tapi jika ada harus array
  if (newsData.economicCalendar && !Array.isArray(newsData.economicCalendar)) {
    logger.warn('⚠️ economicCalendar bukan array, abaikan');
    newsData.economicCalendar = [];
  }

  // Format menjadi pesan WhatsApp
  const message = formatNewsMessage(newsData);

  // ── Kirim ke grup tertaut atau fallback ke owner ──────────────────────
  const targetGroups = getGroupOutput('economicNews');

  if (targetGroups.length > 0) {
    logger.info({ groups: targetGroups.length }, '📤 Kirim berita ke grup tertaut');
    for (const groupJid of targetGroups) {
      try {
        await global._sock?.sendMessage(groupJid, { text: message });
        logger.info({ groupJid }, '✅ Berita terkirim ke grup');
      } catch (err) {
        logger.error({ groupJid, err: err.message }, '❌ Gagal kirim berita ke grup');
      }
    }
  } else {
    const ownerJid = config.ownerLid || config.ownerJid;
    if (!ownerJid) {
      logger.warn('⚠️ Tidak ada grup tertaut dan owner JID tidak diset, skip kirim berita');
      return;
    }
    try {
      await global._sock?.sendMessage(ownerJid, { text: message });
      logger.info({ ownerJid }, '✅ Berita terkirim ke owner (tidak ada grup tertaut)');
    } catch (err) {
      logger.error({ err: err.message }, '❌ Gagal kirim berita ke owner');
    }
  }
}

// ─── Plugin export ────────────────────────────────────────────────────────
export default {
  name: 'EconomicNews',
  description: 'Kirim ringkasan berita ekonomi global dan Indonesia setiap 4 jam via Qwen AI',

  crons: [
    {
      name: 'scheduled:economicNews',
      expr: '@every_4h',
      handler: sendEconomicNews,
      runOnStart: false,
    },
  ],
};