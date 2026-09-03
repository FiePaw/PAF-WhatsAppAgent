// plugins/scheduled/economicNews.js
// Scheduled plugin: kirim ringkasan berita ekonomi global setiap 4 jam.
// AI melaporkan hasil via tool-calling (§9 API_USAGE.md) → diformat menjadi
// pesan WhatsApp yang rapi.
//
// ─── Migrasi dari raw-JSON ke tool-calling ───────────────────────────────
// Sebelumnya: AI diminta balas raw JSON, dan karena model sering menyisipkan
// markdown link `[nama](url)` DI DALAM string `summary`, JSON hasilnya
// sering rusak (newline/karakter aneh di tengah string) — perlu hack
// `sanitizeRawJson()` + regex ekstraksi URL yang rapuh dan sulit dirawat.
// Sekarang: skema tool punya field `sourceUrl` TERPISAH dari `summary` —
// AI tidak perlu lagi menyisipkan markdown link di tengah teks bebas, dan
// gateway sendiri yang menjamin bentuk `tool_calls` (bukan kita yang regex).
//
// Setup grup: !group channel <groupJid> economicNews output/both
// Tanpa grup tertaut: berita dikirim langsung ke DM owner

import { askAITool } from '../../services/aiService.js';
import { buildFunctionTool } from '../../utils/toolCalling.js';
import { getGroupOutput } from '../../services/groupService.js';
import config from '../../config/config.js';
import logger from '../../utils/logger.js';

// ─── Instruksi konten untuk AI (bukan lagi instruksi FORMAT JSON manual) ─
const NEWS_INSTRUCTIONS = `Kamu adalah analis ekonomi profesional. Tugasmu adalah memberikan ringkasan berita ekonomi terkini, lalu melaporkannya lewat tool yang tersedia.

Instruksi GLOBAL (5 berita):
- Pilih berita ekonomi paling penting dari seluruh dunia
- Cakup: pasar keuangan, cryptocurrency, commodity, geopolitik ekonomi, kebijakan central bank, merger & akuisisi besar-besaran
- Sumber Utama: Twitter/X, Instagram, TikTok dari akun resmi ekonomi/keuangan global (misal: @WSJ, @Bloomberg, @Reuters, @FT, @CNBC, @MarketWatch) dan sumber berita online terpercaya lainnya
- Sumber: Reuters, Bloomberg, WSJ, Financial Times, CNBC, MarketWatch, dan sumber terpercaya lainnya

Instruksi ECONOMIC CALENDAR (diekstrak dari ForexFactory, TradingView, atau sumber sejenis):
- Ambil 5 event ekonomi paling penting yang akan/sedang terjadi (NFP, CPI, PPI, Interest Rate Decision, GDP, dll)
- Negara: US, EU, Inggris, Jepang, China, atau negara dengan dampak global besar
- Waktu: dalam format WIB daerah Bekasi di Indonesia
- Impact: HIGH untuk acara pemecah pasar, MEDIUM untuk moderate, LOW untuk minor

Instruksi INDONESIA (5 berita):
- Fokus pada ekonomi Indonesia, IHSG, rupiah, inflasi, BI policy, sektor industri lokal
- Cakup: pasar modal, perbankan, pertanian, manufaktur, trade, investasi asing, dan teknologi
- Sumber: Tempo, Kompas, Bisnis, Detik, Antara, Katadata, Kontan, atau media sosial seperti Twitter/X, Instagram, TikTok dari akun resmi ekonomi/keuangan Indonesia

Aturan field "hot": Tandai true hanya jika berita tersebut benar-benar luar biasa, misalnya: kolaps pasar mendadak, kebijakan darurat pemerintah, bencana ekonomi, rekor bersejarah, atau peristiwa yang jarang terjadi dalam dekade. Berita rutin tetap false.

Aturan WAJIB:
- Field "summary" HARUS plain text saja — JANGAN menyisipkan link/markdown apapun di dalamnya. Taruh URL sumber di field "sourceUrl" yang terpisah.
- "sourceUrl" harus URL lengkap dan valid dengan protokol https://
- Jangan ulangi berita dari update sebelumnya
- JANGAN MENGGUNAKAN MARKDOWN apapun di dalam summary, cukup plain text.

Gunakan bahasa Indonesia yang singkat, jelas, dan mudah dipahami. Setelah selesai menganalisa, panggil tool "report_economic_update" dengan hasilnya.`;

// ─── Tool schema ─────────────────────────────────────────────────────────
const newsItemSchema = {
  type: 'object',
  properties: {
    headline: { type: 'string', description: 'Judul singkat berita' },
    summary: { type: 'string', description: '1-3 kalimat ringkasan, PLAIN TEXT saja, TANPA link/markdown di dalamnya' },
    sourceUrl: { type: 'string', description: 'URL lengkap sumber berita (https://...), field terpisah dari summary' },
    hot: { type: 'boolean', description: 'true hanya jika berita ini benar-benar luar biasa/jarang terjadi' },
  },
  required: ['headline', 'summary', 'sourceUrl', 'hot'],
};

const calendarItemSchema = {
  type: 'object',
  properties: {
    event: { type: 'string', description: 'Nama event ekonomi penting' },
    country: { type: 'string', description: 'Kode negara: US, EUR, GBP, JPY, dll' },
    time: { type: 'string', description: 'Waktu WIB daerah Bekasi, format: DD MMM YYYY HH:mm WIB' },
    forecast: { type: 'string', description: 'Prediksi/ekspektasi nilai' },
    previous: { type: 'string', description: 'Nilai sebelumnya' },
    impact: { type: 'string', enum: ['HIGH', 'MEDIUM', 'LOW'], description: 'Dampak event ke pasar' },
  },
  required: ['event', 'country', 'time', 'forecast', 'previous', 'impact'],
};

const economicNewsTool = buildFunctionTool(
  'report_economic_update',
  'Laporkan hasil analisa ringkasan berita ekonomi global, kalender ekonomi, dan berita Indonesia.',
  {
    type: 'object',
    properties: {
      datetime: { type: 'string', description: 'Tanggal & waktu sekarang di Bekasi, Indonesia, format: DD MMM YYYY HH:mm WIB' },
      global: { type: 'array', items: newsItemSchema, description: '5 berita ekonomi global paling penting' },
      economicCalendar: { type: 'array', items: calendarItemSchema, description: '5 event ekonomi penting (kosongkan array jika tidak ada)' },
      indonesia: { type: 'array', items: newsItemSchema, description: '5 berita ekonomi Indonesia paling penting' },
    },
    required: ['datetime', 'global', 'indonesia'],
  }
);

// ─── Format hasil tool → pesan WhatsApp ──────────────────────────────────
/**
 * Ubah hasil report_economic_update dari AI menjadi teks siap kirim ke
 * WhatsApp. sourceUrl sudah berupa field terpisah — tidak perlu lagi
 * ekstraksi/pembersihan marker seperti versi lama.
 * @param {object} data - args dari tool_call report_economic_update
 * @returns {string}
 */
function formatNewsMessage(data) {
  const lines = [];

  lines.push(`📊 *Update Ekonomi*`);
  lines.push(`🕐 ${data.datetime}`);
  lines.push('');

  lines.push('🌍 *Global*');
  for (const item of data.global) {
    if (item.hot) {
      lines.push(`🔥 *[HOTNEWS]* \`${item.headline}\``);
      lines.push(`  *${item.summary}*`);
    } else {
      lines.push(`• *${item.headline}*`);
      lines.push(`  ${item.summary}`);
    }
    if (item.sourceUrl) {
      lines.push(`  [🔗 Sumber](${item.sourceUrl})`);
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
    if (item.hot) {
      lines.push(`🔥 *[HOTNEWS]* \`${item.headline}\``);
      lines.push(`  *${item.summary}*`);
    } else {
      lines.push(`• *${item.headline}*`);
      lines.push(`  ${item.summary}`);
    }
    if (item.sourceUrl) {
      lines.push(`  [🔗 Sumber](${item.sourceUrl})`);
    }
  }

  lines.push('');
  lines.push('_Sumber: analisis AI berdasarkan data terkini_');

  return lines.join('\n');
}

// ─── Handler utama ────────────────────────────────────────────────────────
async function sendEconomicNews() {
  logger.info('📰 Menjalankan scheduled economic news...');

  let result;
  try {
    result = await askAITool({
      jid: 'scheduled:economicNews',
      userText: 'Berikan update berita ekonomi sekarang. Note: dengan data terupdate dari sumber utama yaitu tiktok, instagram, x.com, dan sumber berita online lainnya. Jangan berikan berita yang sudah pernah kamu berikan sebelumnya.',
      systemPrompt: NEWS_INSTRUCTIONS,
      tools: [economicNewsTool],
      thinkMode: 'thinking',
      model: config.ai.taskModel,
    });
  } catch (err) {
    logger.error({ err: err.message }, '❌ Gagal ambil berita ekonomi dari AI');
    return;
  }

  // Retry sekali jika AI tidak memanggil tool (jarang terjadi dengan
  // tool-calling, tapi tetap dijaga sebagai fallback)
  if (result.name !== 'report_economic_update') {
    logger.warn({ preview: result.raw?.slice(0, 100) }, '⚠️ AI tidak memanggil tool report_economic_update, retry sekali...');
    try {
      result = await askAITool({
        jid: 'scheduled:economicNews',
        userText: 'PERINTAH ULANG: kamu WAJIB memanggil tool "report_economic_update" dengan hasil analisa berita ekonomi terkini. Jangan hanya menulis teks biasa.',
        systemPrompt: NEWS_INSTRUCTIONS,
        tools: [economicNewsTool],
        thinkMode: 'thinking',
        model: config.ai.taskModel,
      });
    } catch (err) {
      logger.error({ err: err.message }, '❌ Gagal ambil berita ekonomi dari AI (retry)');
      return;
    }
    if (result.name !== 'report_economic_update') {
      logger.error('❌ AI tetap tidak memanggil tool setelah retry, skip');
      return;
    }
  }

  const newsData = result.args;

  // Validasi field wajib
  if (!newsData.datetime || !Array.isArray(newsData.global) || !Array.isArray(newsData.indonesia)) {
    logger.error({ newsData }, '❌ Struktur hasil berita tidak valid');
    return;
  }

  // Validasi jumlah item (minimal 5 untuk global & indonesia)
  if (newsData.global.length < 5 || newsData.indonesia.length < 5) {
    logger.warn({
      globalCount: newsData.global.length,
      indonesiaCount: newsData.indonesia.length,
    }, '⚠️ Jumlah berita kurang dari 5, lanjutkan saja');
  }

  // economicCalendar opsional tapi jika ada harus array
  if (newsData.economicCalendar && !Array.isArray(newsData.economicCalendar)) {
    logger.warn('⚠️ economicCalendar bukan array, abaikan');
    newsData.economicCalendar = [];
  }

  // Format menjadi pesan WhatsApp
  const message = formatNewsMessage(newsData);

  // ─ Kirim ke grup tertaut atau fallback ke owner ─────────────────────
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
  description: 'Kirim ringkasan berita ekonomi global dan Indonesia setiap 4 jam via AI (tool-calling)',

  crons: [
    {
      name: 'scheduled:economicNews',
      expr: '@every_4h',
      handler: sendEconomicNews,
      runOnStart: false,
    },
  ],
};
