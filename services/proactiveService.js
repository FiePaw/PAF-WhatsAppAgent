// services/proactiveService.js
// Service analisa chatHistory setiap 10 menit (cron @every_10m).
// isAnalysisAllowed() mengatur per-JID kapan boleh dianalisa berdasarkan nextAnalyzeAt.
//
// Anti-spam: cooldown 30 menit per JID — hanya satu pesan outbound per 30 menit.
//
// Sistem prioritas per siklus (satu pesan per JID):
//   1. Follow-up due       → prioritas tertinggi, langsung kirim dan selesai
//   2. Analisa Qwen        → event personal → event nasional → proactive reguler
//
// Arsitektur keputusan Qwen:
//   Qwen TIDAK memutuskan apakah kirim atau tidak (tidak ada shouldSend).
//   Qwen hanya menulis pesan terbaik — jika ada isinya → kirim, kosong → skip.

import cronService from './cronService.js';
import { getActiveJids, getHistory, pruneAllOldMessages } from './chatHistoryService.js';
import { getPresence, subscribePresence, subscribeAll } from './presenceService.js';
import { getUserProfile, formatUserProfileForPrompt } from './userProfileService.js';
import { formatFollowUpsForPrompt, getDueFollowUps, sendFollowUp } from './followUpService.js';
import { buildEnrichedContext } from './contextEnricher.js';
import { askAI } from './aiService.js';
import { getPersona } from './personaService.js';
import db from './db.js';
import config from '../config/config.js';
import logger from '../utils/logger.js';

const STATE_COLLECTION = 'proactiveState';

// Cooldown minimum antar pesan outbound ke JID yang sama (dari sumber manapun)
const COOLDOWN_MS = 30 * 60 * 1000; // 30 menit

// ─── State helpers ────────────────────────────────────────────────────────────

function getState(jid) {
  return db.findOne(STATE_COLLECTION, { jid }) ?? { jid, nextAnalyzeAt: null, lastSentAt: null };
}

async function saveState(jid, updates) {
  await db.upsert(STATE_COLLECTION, { jid }, updates);
}

/**
 * Catat waktu terakhir pesan dikirim ke JID.
 * Dipanggil setiap kali pesan outbound berhasil terkirim (dari sumber manapun).
 * @param {string} jid
 */
export async function recordSent(jid) {
  await saveState(jid, { lastSentAt: new Date().toISOString() });
}

/**
 * Cek apakah cooldown sudah lewat untuk JID ini.
 * @param {string} jid
 * @returns {boolean}
 */
function isCooldownClear(jid) {
  const state = getState(jid);
  if (!state.lastSentAt) return true;
  return Date.now() - new Date(state.lastSentAt).getTime() >= COOLDOWN_MS;
}

/**
 * Parse nextAnalyzeIn shorthand ke ISO timestamp.
 * Format: "10m" | "15m" | "20m" | "30m" | "45m" | "1h" | null
 * null → default 15 menit (agresif — cek lagi secepatnya)
 * Maksimum yang diizinkan: 1 jam. Lebih dari itu di-cap ke 1h.
 */
function resolveNextAnalyzeAt(nextAnalyzeIn) {
  const MAX_MS = 60 * 60 * 1000; // cap 1 jam

  if (!nextAnalyzeIn) {
    return new Date(Date.now() + 15 * 60 * 1000).toISOString(); // default 15m
  }
  const match = nextAnalyzeIn.match(/^(\d+)(m|h)$/);
  if (!match) {
    logger.warn({ nextAnalyzeIn }, '⚠️ proactiveService: format nextAnalyzeIn tidak dikenal, pakai default 15m');
    return new Date(Date.now() + 15 * 60 * 1000).toISOString();
  }
  const value = parseInt(match[1]);
  const unit = match[2];
  const ms = Math.min(
    unit === 'm' ? value * 60 * 1000 : value * 60 * 60 * 1000,
    MAX_MS
  );
  return new Date(Date.now() + ms).toISOString();
}

function isAnalysisAllowed(jid) {
  const state = getState(jid);
  if (!state.nextAnalyzeAt) return true;
  return new Date().toISOString() >= state.nextAnalyzeAt;
}

// ─── Prompt builder ───────────────────────────────────────────────────────────

function buildAnalysisPrompt(jid, history, presence, enrichedContext) {
  const firstSent = history[0]?.firstSent ?? '-';
  const lastSent = history[history.length - 1]?.lastSent ?? '-';

  const conversation = history
    .map((e) => {
      const time = new Date(e.timestamp).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
      const roleLabel = e.role === 'bot' ? '🤖 Bot' : '👤 User';
      return `[${time}] ${roleLabel}: ${e.text}`;
    })
    .join('\n');

  const presenceInfo = presence.isStale
    ? 'Status: Tidak diketahui'
    : `Status: ${presence.isOnline ? '🟢 ONLINE' : '🔴 OFFLINE'} (${presence.lastKnownPresence})${
        presence.lastSeen
          ? ` · Terakhir online: ${new Date(presence.lastSeen).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })}`
          : ''
      }`;

  const now = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });

  const msSinceLast = lastSent !== '-' ? Date.now() - new Date(lastSent).getTime() : null;
  const timeSinceLast = msSinceLast !== null
    ? msSinceLast < 60_000 ? 'baru saja'
    : msSinceLast < 3_600_000 ? `${Math.floor(msSinceLast / 60_000)} menit lalu`
    : `${Math.floor(msSinceLast / 3_600_000)} jam lalu`
    : 'tidak diketahui';

  return `Kamu adalah teman dekat yang sedang membaca riwayat chat WhatsApp dengan seseorang. Tugasmu SATU: tulis pesan terbaik untuk dikirim sekarang berdasarkan konteks percakapan.

Kamu TIDAK memutuskan apakah harus kirim atau tidak. Itu bukan tugasmu. Tugasmu hanya menulis pesan yang paling tepat dan natural berdasarkan apa yang kamu baca.

=== WAKTU SEKARANG ===
${now}

=== INFO KONTAK ===
Percakapan dimulai: ${new Date(firstSent).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })}
Pesan terakhir: ${new Date(lastSent).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })} (${timeSinceLast})
Total pesan: ${history.length}
${presenceInfo}

${enrichedContext ? enrichedContext + '\n' : ''}=== RIWAYAT PERCAKAPAN ===
${conversation}

=== CARA BERPIKIR ===
Baca percakapan di atas, lalu temukan pesan yang paling tepat dengan urutan prioritas ini:
1. Ada follow-up terjadwal yang waktunya sudah tiba? → kirim follow-up itu
2. Ada event/hari besar yang relevan dengan user? → singgung secara natural
3. Ada topik yang belum selesai atau pertanyaan yang belum terjawab? → lanjutkan
4. Ada sesuatu yang user ceritakan (perasaan, rencana, kejadian)? → respons lebih dalam
5. Tidak ada yang spesifik? → buat topik natural berdasarkan profil dan kepribadian user

=== PANDUAN nextAnalyzeIn ===
Tentukan kapan bot harus menganalisa kontak ini lagi:
- "10m" → user online aktif, pantau respons
- "15m" → situasi aktif, perlu follow-up cepat  
- "20m" → baru kirim pesan, tunggu sebentar
- "30m" → tidak ada yang terlalu mendesak
- "45m" → situasi santai
- "1h"  → maksimal, gunakan jika benar-benar tidak ada yang perlu dipantau

=== FORMAT RESPONSE ===
Balas HANYA dengan JSON valid (tanpa komentar, tanpa markdown backtick):
{
  "message": "pesan yang akan dikirim — tulis dengan natural, 1-3 kalimat",
  "reason": "dari mana kamu menemukan konteks pesan ini",
  "nextAnalyzeIn": "10m" | "15m" | "20m" | "30m" | "45m" | "1h",
  "contextSummary": "ringkasan 1-2 kalimat konteks percakapan ini"
}`;
}

function buildContextInjection(targetJid, analysis, presence) {
  const timeStr = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
  const onlineStatus = presence.isStale
    ? 'tidak diketahui'
    : presence.isOnline ? 'online' : 'offline';
  const actionStatus = analysis.message?.trim()
    ? `✅ Pesan inisiatif DIKIRIM`
    : '⏭️ Tidak ada pesan dikirim';

  return `[SISTEM - Proactive Service Report @ ${timeStr}]

Kontak yang dianalisa: ${targetJid}
Status user saat analisa: ${onlineStatus}
Ringkasan konteks: ${analysis.contextSummary}
Keputusan: ${actionStatus}
Alasan: ${analysis.reason}
Analisa berikutnya: ${analysis.nextAnalyzeIn ?? '15m (default)'}
${analysis.message?.trim() ? `\nPesan yang dikirim: "${analysis.message}"` : ''}

Ini laporan otomatis proactiveService. Kamu kini memahami apa yang baru saja dilakukan bot terhadap kontak ini secara proaktif.`;
}

// ─── Core Logic ───────────────────────────────────────────────────────────────

async function analyzeAndActForJid(jid) {
  if (!isAnalysisAllowed(jid)) {
    const state = getState(jid);
    logger.debug({ jid, nextAnalyzeAt: state.nextAnalyzeAt }, '⏳ proactiveService: belum waktunya, skip');
    return;
  }

  const history = getHistory(jid);
  if (history.length === 0) {
    logger.debug({ jid }, '⏭️ proactiveService: history kosong, skip');
    return;
  }

  const presence = getPresence(jid);
  const ownerJid = config.ownerLid || config.ownerJid;
  const isOwnerJid = jid === ownerJid;
  const { prompt: systemPrompt, model } = getPersona(jid, isOwnerJid);

  // ── Cek cooldown — satu pesan per 30 menit per JID ────────────────────────
  // Follow-up dengan isUrgent bisa bypass cooldown (lihat di bawah).
  const cooldownClear = isCooldownClear(jid);
  const state = getState(jid);
  if (!cooldownClear) {
    const remaining = Math.ceil(
      (COOLDOWN_MS - (Date.now() - new Date(state.lastSentAt).getTime())) / 60_000
    );
    logger.debug({ jid, remainingMinutes: remaining }, '⏸️ proactiveService: cooldown aktif, skip kirim');
    // Tetap jadwalkan analisa berikutnya
    await saveState(jid, { nextAnalyzeAt: resolveNextAnalyzeAt('15m') });
    return;
  }

  // ── Prioritas 1: Follow-up due ────────────────────────────────────────────
  // Prioritas tertinggi — sudah dijanjikan ke user, harus dikirim.
  // Hanya satu follow-up per siklus untuk hindari burst.
  const dueFollowUps = getDueFollowUps().filter((e) => e.jid === jid);
  if (dueFollowUps.length > 0) {
    const followUp = dueFollowUps[0]; // ambil satu saja per siklus
    logger.info({ jid, event: followUp.event }, '📅 proactiveService: follow-up due, kirim sekarang');
    await sendFollowUp(followUp, history, systemPrompt);
    await recordSent(jid);
    // Selesai untuk siklus ini — skip analisa proactive reguler
    await saveState(jid, { nextAnalyzeAt: resolveNextAnalyzeAt('20m') });
    return;
  }

  logger.info(
    { jid, messages: history.length, online: presence.isOnline, stale: presence.isStale },
    '🔍 proactiveService: menganalisa JID...'
  );

  // ── Kumpulkan enriched context ─────────────────────────────────────────────
  const userProfile = getUserProfile(jid);
  const profileText = formatUserProfileForPrompt(jid);
  const followUpsText = formatFollowUpsForPrompt(jid);
  const enrichedContext = [
    profileText,
    buildEnrichedContext({ history, userProfile, followUps: followUpsText }),
  ].filter(Boolean).join('\n\n');

  // ── Prioritas 2-4: Analisa Qwen (event personal, event nasional, proactive) ─
  const prompt = buildAnalysisPrompt(jid, history, presence, enrichedContext);
  let analysis;

  try {
    const rawResponse = await askAI({
      jid: `proactive_analysis_${jid}`,
      userText: prompt,
      systemPrompt: 'Kamu adalah sistem analisa percakapan WhatsApp. Tugasmu HANYA menulis pesan terbaik berdasarkan konteks. Balas dengan JSON valid sesuai format. Tidak ada teks lain selain JSON.',
    });

    const cleaned = rawResponse.replace(/```json|```/gi, '').trim();
    analysis = JSON.parse(cleaned);

    logger.info(
      { jid, nextAnalyzeIn: analysis.nextAnalyzeIn, reason: analysis.reason, preview: analysis.message?.slice(0, 60) },
      '🧠 proactiveService: analisa Qwen selesai'
    );
  } catch (err) {
    logger.error({ jid, err: err.message }, '❌ proactiveService: gagal analisa atau parse JSON');
    await saveState(jid, { nextAnalyzeAt: resolveNextAnalyzeAt('30m') });
    return;
  }

  // ── Kirim pesan jika Qwen menghasilkan pesan ───────────────────────────────
  if (analysis.message?.trim()) {
    const sock = global._sock;
    if (!sock) {
      logger.warn({ jid }, '⚠️ proactiveService: sock tidak tersedia');
    } else {
      try {
        await sock.sendMessage(jid, { text: analysis.message.trim() });
        await recordSent(jid);
        logger.info(
          { jid, preview: analysis.message.slice(0, 60) },
          '📤 proactiveService: pesan inisiatif terkirim'
        );
      } catch (err) {
        logger.error({ jid, err: err.message }, '❌ proactiveService: gagal kirim pesan');
      }
    }
  } else {
    logger.info({ jid }, '⏭️ proactiveService: Qwen tidak menghasilkan pesan, skip');
  }

  // ── Inject konteks ke session chat JID ────────────────────────────────────
  try {
    await askAI({
      jid,
      userText: buildContextInjection(jid, analysis, presence),
      systemPrompt,
      model,
    });
    logger.info({ targetJid: jid, isOwner: isOwnerJid }, '💉 proactiveService: konteks diinjeksi ke session JID target');
  } catch (err) {
    logger.warn({ jid, err: err.message }, '⚠️ proactiveService: gagal inject konteks ke session target');
  }

  // ── Simpan nextAnalyzeAt ───────────────────────────────────────────────────
  await saveState(jid, { nextAnalyzeAt: resolveNextAnalyzeAt(analysis.nextAnalyzeIn ?? null) });
  logger.debug({ jid, nextAnalyzeAt: getState(jid).nextAnalyzeAt }, '🗓️ proactiveService: jadwal analisa berikutnya tersimpan');
}

async function runProactiveAnalysis() {
  logger.info('🚀 proactiveService: memulai siklus analisa...');

  await pruneAllOldMessages();

  const activeJids = getActiveJids();
  if (activeJids.length === 0) {
    logger.info('📭 proactiveService: tidak ada JID aktif');
    return;
  }

  logger.info({ count: activeJids.length }, '📋 proactiveService: JID aktif ditemukan');

  // Re-subscribe presence (jaga-jaga setelah reconnect)
  await subscribeAll(activeJids);

  for (const jid of activeJids) {
    try {
      await analyzeAndActForJid(jid);
      await new Promise((r) => setTimeout(r, 3000));
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
 *
 * @param {string[]} activeJids - untuk subscribe presence awal
 */
export async function initProactiveService(activeJids = []) {
  if (activeJids.length > 0) {
    await subscribeAll(activeJids);
  }

  cronService.register(
    'proactiveAnalysis',
    '@every_10m',       // cek setiap 10 menit — isAnalysisAllowed() yang mengatur per-JID
    runProactiveAnalysis,
    { autoStart: true, runOnRegister: false }
  );

  logger.info('🔔 proactiveService: cron job terdaftar (@every_10m)');
}

/**
 * Subscribe presence ke JID baru.
 * Dipanggil dari chatHistoryService saat JID pertama kali muncul.
 *
 * @param {string} jid
 */
export async function onNewJid(jid) {
  await subscribePresence(jid);
}