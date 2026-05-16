// services/proactiveService.js
// Service yang berjalan setiap 1 jam untuk menganalisa chatHistory per JID.
// Qwen memutuskan apakah perlu mengirim pesan inisiatif ke kontak tersebut.
//
// Alur:
// 1. Ambil semua JID aktif dari chatHistoryService
// 2. Per JID: format history lalu kirim ke Qwen untuk dianalisa
// 3. Jika Qwen memutuskan shouldSend: true → kirim pesan ke JID target
// 4. Inject ringkasan hasil analisa ke chat session owner/user agar mereka paham konteks

import cronService from './cronService.js';
import { getActiveJids, getHistory, pruneAllOldMessages } from './chatHistoryService.js';
import { askAI } from './aiService.js';
import { getPersona } from './personaService.js';
import config from '../config/config.js';
import logger from '../utils/logger.js';

// ─── Prompt Template ──────────────────────────────────────────────────────────

/**
 * Buat prompt analisa untuk Qwen berdasarkan history chat satu JID.
 * Output yang diminta: JSON { shouldSend, message, reason, contextSummary }
 *
 * @param {string} jid
 * @param {object[]} history - array entry chatHistory
 * @returns {string}
 */
function buildAnalysisPrompt(jid, history) {
  const firstSent = history[0]?.firstSent ?? '-';
  const lastSent = history[history.length - 1]?.lastSent ?? '-';

  // Format history menjadi teks percakapan
  const conversation = history
    .map((e) => {
      const time = new Date(e.timestamp).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
      const roleLabel = e.role === 'bot' ? '🤖 Bot' : '👤 User';
      return `[${time}] ${roleLabel}: ${e.text}`;
    })
    .join('\n');

  return `Kamu adalah asisten WhatsApp bot yang cerdas dan proaktif. Tugasmu adalah menganalisa riwayat percakapan dengan kontak berikut dan memutuskan apakah bot perlu mengirimkan pesan inisiatif (tanpa diminta lebih dulu).

=== DATA KONTAK ===
JID: ${jid}
Pesan pertama tercatat: ${new Date(firstSent).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })}
Pesan terakhir tercatat: ${new Date(lastSent).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })}
Total pesan: ${history.length}

=== RIWAYAT PERCAKAPAN ===
${conversation}

=== TUGAS ===
Berdasarkan riwayat di atas, tentukan:
1. Apakah ada hal yang bisa dilakukan untuk mengirim pesan inisiatif sekarang? (misalnya: follow-up topik yang belum selesai, mengingatkan sesuatu, memberikan info relevan, sapaan natural, membahas hal yang questionable, dan lain lain)
2. Jika ya, apa pesan yang tepat untuk dikirim? (harus terasa natural dan sesuai konteks, bukan pesan kaku atau terlalu formal)
3. Jika tidak, tunggu saja sampai beberapa saat jika tidak ada respon dari user dari sekian lama, maka lakukan pesan inisiatif sesuai konteks dan riwayat percakapan.
3. Buat ringkasan singkat konteks percakapan ini untuk dilaporkan ke user.

Balas HANYA dengan JSON valid berikut (tanpa komentar, tanpa markdown):
{
  "shouldSend": true | false,
  "message": "pesan yang akan dikirim ke kontak (kosong jika shouldSend false)",
  "reason": "alasan singkat keputusan kamu",
  "contextSummary": "ringkasan 1-2 kalimat konteks percakapan ini untuk dilaporkan ke user"
}`;
}

/**
 * Buat teks injeksi konteks ke session owner/user.
 * Dikirim ke Qwen via askAI agar session memahami apa yang baru dilakukan bot.
 *
 * @param {string} targetJid
 * @param {object} analysis - { shouldSend, message, reason, contextSummary }
 * @returns {string}
 */
function buildContextInjection(targetJid, analysis) {
  const timeStr = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
  const status = analysis.shouldSend ? '✅ Pesan inisiatif DIKIRIM' : '⏭️ Tidak ada pesan dikirim';

  return `[SISTEM - Proactive Service Report @ ${timeStr}]

Bot baru saja menyelesaikan analisa otomatis untuk kontak: ${targetJid}

Ringkasan konteks: ${analysis.contextSummary}
Keputusan: ${status}
Alasan: ${analysis.reason}
${analysis.shouldSend ? `Pesan yang dikirim: "${analysis.message}"` : ''}

Ini adalah laporan otomatis dari proactiveService. Kamu sekarang memahami konteks apa yang baru dilakukan bot terhadap kontak ini.`;
}

// ─── Core Logic ───────────────────────────────────────────────────────────────

/**
 * Analisa satu JID: ambil history, minta Qwen analisa, kirim pesan jika perlu,
 * lalu inject konteks ke session owner.
 *
 * @param {string} jid - JID target yang dianalisa
 */
async function analyzeAndActForJid(jid) {
  const history = getHistory(jid);
  if (history.length === 0) {
    logger.debug({ jid }, '⏭️ proactiveService: history kosong, skip');
    return;
  }

  logger.info({ jid, messageCount: history.length }, '🔍 proactiveService: menganalisa JID...');

  // ── Step 1: Kirim ke Qwen untuk analisa ────────────────────────────────────
  const prompt = buildAnalysisPrompt(jid, history);
  let analysis;

  try {
    // Gunakan session terpisah khusus proactive (jangan campur dengan session chat user)
    const analysisJid = `proactive_analysis_${jid}`;
    const rawResponse = await askAI({
      jid: analysisJid,
      userText: prompt,
      systemPrompt: 'Kamu adalah sistem analisa percakapan WhatsApp. Selalu balas dengan JSON valid sesuai format yang diminta.',
    });

    // Parse JSON dari response Qwen
    const cleaned = rawResponse.replace(/```json|```/gi, '').trim();
    analysis = JSON.parse(cleaned);

    logger.info(
      { jid, shouldSend: analysis.shouldSend, reason: analysis.reason },
      '🧠 proactiveService: analisa Qwen selesai'
    );
  } catch (err) {
    logger.error({ jid, err: err.message }, '❌ proactiveService: gagal analisa atau parse JSON');
    return;
  }

  // ── Step 2: Kirim pesan inisiatif ke JID target jika shouldSend true ───────
  if (analysis.shouldSend && analysis.message?.trim()) {
    const sock = global._sock;
    if (!sock) {
      logger.warn({ jid }, '⚠️ proactiveService: sock tidak tersedia, pesan tidak dikirim');
    } else {
      try {
        await sock.sendMessage(jid, { text: analysis.message.trim() });
        logger.info({ jid, message: analysis.message.slice(0, 60) }, '📤 proactiveService: pesan inisiatif terkirim');
      } catch (err) {
        logger.error({ jid, err: err.message }, '❌ proactiveService: gagal kirim pesan');
      }
    }
  }

  // ── Step 3: Inject konteks ke session chat owner ───────────────────────────
  // Tujuan: agar saat owner chat selanjutnya, Qwen sudah paham konteks apa
  // yang baru dilakukan bot secara otomatis terhadap kontak ini.
  const ownerJid = config.ownerLid || config.ownerJid;
  if (ownerJid) {
    try {
      const { prompt: ownerSystemPrompt, model: ownerModel } = getPersona(ownerJid, true);
      const contextText = buildContextInjection(jid, analysis);

      // Inject ke session owner — tidak perlu reply, cukup masuk ke context window Qwen
      await askAI({
        jid: ownerJid,
        userText: contextText,
        systemPrompt: ownerSystemPrompt,
        model: ownerModel,
      });

      logger.info({ ownerJid, targetJid: jid }, '💉 proactiveService: konteks berhasil diinjeksi ke session owner');
    } catch (err) {
      logger.warn({ jid, err: err.message }, '⚠️ proactiveService: gagal inject konteks ke session owner');
    }
  }
}

/**
 * Main runner: jalankan analisa untuk semua JID aktif secara berurutan
 * (bukan paralel — agar tidak membebani API).
 */
async function runProactiveAnalysis() {
  logger.info('🚀 proactiveService: memulai siklus analisa...');

  // Cleanup global dulu sebelum analisa
  await pruneAllOldMessages();

  const activeJids = getActiveJids();

  if (activeJids.length === 0) {
    logger.info('📭 proactiveService: tidak ada JID aktif, siklus selesai');
    return;
  }

  logger.info({ count: activeJids.length }, '📋 proactiveService: JID aktif ditemukan');

  // Proses satu per satu agar tidak spam ke API
  for (const jid of activeJids) {
    try {
      await analyzeAndActForJid(jid);
      // Jeda antar JID agar API tidak terbebani
      await new Promise((res) => setTimeout(res, 3000));
    } catch (err) {
      logger.error({ jid, err: err.message }, '❌ proactiveService: error saat analisa JID');
    }
  }

  logger.info('✅ proactiveService: siklus analisa selesai');
}

// ─── Init ─────────────────────────────────────────────────────────────────────

/**
 * Daftarkan cron job proactive ke cronService.
 * Dipanggil dari bot.js saat koneksi terbuka.
 * Job berjalan setiap 1 jam (pukul xx:00).
 */
export function initProactiveService() {
  cronService.register(
    'proactiveAnalysis',
    '@every_5m',
    runProactiveAnalysis,
    {
      autoStart: true,
      runOnRegister: false, // tidak langsung jalan saat init, tunggu 1 jam pertama
    }
  );

  logger.info('🔔 proactiveService: cron job terdaftar (@every_8m)');
}