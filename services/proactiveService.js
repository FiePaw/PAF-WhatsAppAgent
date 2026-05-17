// services/proactiveService.js
// Service analisa chatHistory setiap 10 menit (cron @every_10m).
// isAnalysisAllowed() mengatur per-JID kapan boleh dianalisa berdasarkan nextAnalyzeAt.
// Qwen memutuskan: apakah perlu kirim pesan, kapan analisa boleh dilakukan lagi.
// nextAnalyzeIn maksimal 1 jam — Qwen didorong untuk agresif dan responsif.
//
// Skema keputusan Qwen:
// ┌──────────────┬──────────────────┬────────────────────────────────────────────┐
// │  isOnline    │  shouldSend      │  Tindakan                                  │
// ├──────────────┼──────────────────┼────────────────────────────────────────────┤
// │  true        │  true            │  Kirim pesan inisiatif                     │
// │  true        │  false           │  Skip, simpan nextAnalyzeAt                │
// │  false       │  true + urgent   │  Kirim pesan (topik penting)               │
// │  false       │  true (biasa)    │  Kirim pesan (default agresif)             │
// │  false       │  false           │  Skip, simpan nextAnalyzeAt                │
// └──────────────┴──────────────────┴────────────────────────────────────────────┘

import cronService from './cronService.js';
import { getActiveJids, getHistory, pruneAllOldMessages } from './chatHistoryService.js';
import { getPresence, subscribePresence, subscribeAll } from './presenceService.js';
import { askAI } from './aiService.js';
import { getPersona } from './personaService.js';
import db from './db.js';
import config from '../config/config.js';
import logger from '../utils/logger.js';

const STATE_COLLECTION = 'proactiveState';

// ─── State helpers ────────────────────────────────────────────────────────────

function getState(jid) {
  return db.findOne(STATE_COLLECTION, { jid }) ?? { jid, nextAnalyzeAt: null };
}

async function saveState(jid, updates) {
  await db.upsert(STATE_COLLECTION, { jid }, updates);
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

function buildAnalysisPrompt(jid, history, presence) {
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

  // Hitung berapa lama sejak pesan terakhir
  const msSinceLast = lastSent !== '-' ? Date.now() - new Date(lastSent).getTime() : null;
  const timeSinceLast = msSinceLast !== null
    ? msSinceLast < 60_000 ? 'baru saja'
    : msSinceLast < 3_600_000 ? `${Math.floor(msSinceLast / 60_000)} menit lalu`
    : `${Math.floor(msSinceLast / 3_600_000)} jam lalu`
    : 'tidak diketahui';

  return `Kamu adalah teman dekat yang peduli dan komunikatif via WhatsApp. Tugasmu adalah membaca riwayat percakapan dengan seseorang dan memutuskan pesan terbaik untuk dikirim sekarang berdasarkan konteks.

=== WAKTU SEKARANG ===
${now}

=== DATA KONTAK ===
JID: ${jid}
Percakapan dimulai: ${new Date(firstSent).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })}
Pesan terakhir: ${new Date(lastSent).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })} (${timeSinceLast})
Total pesan tercatat: ${history.length}
${presenceInfo}

=== RIWAYAT PERCAKAPAN ===
${conversation}

=== CARA BERPIKIR ===
Baca percakapan di atas dan jawab dalam dirimu sendiri:
- Apa topik terakhir yang dibicarakan?
- Apakah ada sesuatu yang belum selesai, belum dijawab, atau perlu ditindaklanjuti?
- Apakah ada momen menarik (rencana, perasaan, pertanyaan) yang bisa direspons lebih dalam?
- Jika kamu adalah teman yang membaca chat ini, apa yang paling natural untuk kamu katakan sekarang?

=== PANDUAN KEPUTUSAN ===
User ONLINE → kirim pesan. Ini momen terbaik untuk berinteraksi.
User OFFLINE → tetap kirim jika ada konteks yang bagus (topik belum selesai, ada yang perlu diingatkan, ada follow-up natural). Hanya skip jika benar-benar tidak ada yang relevan untuk dikatakan.
Status tidak diketahui → sama seperti offline.

Prioritas dalam memilih pesan (dari paling diutamakan):
1. Follow-up topik yang belum selesai atau pertanyaan yang belum dijawab
2. Respons terhadap sesuatu yang user ceritakan (mood, rencana, kejadian)
3. Pengingat sesuatu yang user sebut sebelumnya (janji, rencana, niat)
4. Topik baru yang relevan dari analisa kepribadian/kebiasaan user berdasarkan history
5. Sapaan hangat jika sudah lama tidak ada interaksi

=== PANDUAN nextAnalyzeIn ===
Pilih kapan bot harus menganalisa kontak ini lagi:
- "10m" → user online aktif, baru kirim pesan, pantau respons
- "15m" → user online, situasi aktif, perlu follow-up cepat
- "20m" → user online tapi belum tentu aktif, atau baru kirim pesan ke user offline
- "30m" → user offline, ada konteks bagus tapi tidak urgent
- "45m" → situasi santai, tidak ada yang terlalu mendesak
- "1h"  → percakapan sudah cukup lengkap untuk saat ini, cek lagi dalam 1 jam

PENTING: nextAnalyzeIn MAKSIMAL "1h". Jangan pilih lebih dari 1 jam.

=== FORMAT RESPONSE ===
Balas HANYA dengan JSON valid berikut (tanpa komentar, tanpa markdown backtick):
{
  "shouldSend": true | false,
  "isUrgent": true | false,
  "message": "pesan yang akan dikirim (string kosong jika shouldSend false)",
  "reason": "alasan singkat keputusan kamu",
  "nextAnalyzeIn": "10m" | "15m" | "20m" | "30m" | "45m" | "1h",
  "contextSummary": "ringkasan 1-2 kalimat konteks percakapan"
}`;
}

function buildContextInjection(targetJid, analysis, presence) {
  const timeStr = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
  const onlineStatus = presence.isStale
    ? 'tidak diketahui'
    : presence.isOnline ? 'online' : 'offline';
  const actionStatus = analysis.shouldSend
    ? `✅ Pesan inisiatif DIKIRIM${analysis.isUrgent ? ' (URGENT)' : ''}`
    : '⏭️ Tidak ada pesan dikirim';

  return `[SISTEM - Proactive Service Report @ ${timeStr}]

Kontak yang dianalisa: ${targetJid}
Status user saat analisa: ${onlineStatus}
Ringkasan konteks: ${analysis.contextSummary}
Keputusan: ${actionStatus}
Alasan: ${analysis.reason}
Analisa berikutnya dijadwalkan dalam: ${analysis.nextAnalyzeIn ?? '1h (default)'}
${analysis.shouldSend ? `\nPesan yang dikirim: "${analysis.message}"` : ''}

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

  logger.info(
    { jid, messages: history.length, online: presence.isOnline, stale: presence.isStale },
    '🔍 proactiveService: menganalisa JID...'
  );

  // ── Step 1: Analisa Qwen ───────────────────────────────────────────────────
  const prompt = buildAnalysisPrompt(jid, history, presence);
  let analysis;

  try {
    const rawResponse = await askAI({
      jid: `proactive_analysis_${jid}`,
      userText: prompt,
      systemPrompt: 'Kamu adalah sistem analisa percakapan WhatsApp. Selalu balas dengan JSON valid sesuai format yang diminta. Tidak ada teks lain selain JSON.',
    });

    const cleaned = rawResponse.replace(/```json|```/gi, '').trim();
    analysis = JSON.parse(cleaned);

    logger.info(
      { jid, shouldSend: analysis.shouldSend, isUrgent: analysis.isUrgent, nextAnalyzeIn: analysis.nextAnalyzeIn, reason: analysis.reason },
      '🧠 proactiveService: analisa Qwen selesai'
    );
  } catch (err) {
    logger.error({ jid, err: err.message }, '❌ proactiveService: gagal analisa atau parse JSON');
    await saveState(jid, { nextAnalyzeAt: resolveNextAnalyzeAt('1h') });
    return;
  }

  // ── Step 2: Keputusan kirim ────────────────────────────────────────────────
  // Kirim jika: shouldSend true DAN (user online ATAU topik urgent)
  const canSend = analysis.shouldSend && analysis.message?.trim();
  const willSend = canSend && (presence.isOnline || analysis.isUrgent);

  if (canSend && !willSend) {
    logger.info({ jid }, '⏸️ proactiveService: user offline & tidak urgent, tunda pengiriman');
  }

  if (willSend) {
    const sock = global._sock;
    if (!sock) {
      logger.warn({ jid }, '⚠️ proactiveService: sock tidak tersedia');
    } else {
      try {
        await sock.sendMessage(jid, { text: analysis.message.trim() });
        logger.info(
          { jid, urgent: analysis.isUrgent, preview: analysis.message.slice(0, 60) },
          '📤 proactiveService: pesan inisiatif terkirim'
        );
      } catch (err) {
        logger.error({ jid, err: err.message }, '❌ proactiveService: gagal kirim pesan');
      }
    }
  }

  // ── Step 3: Inject konteks ke session chat JID yang dianalisa ────────────
  // Tujuan: agar sesi chat target JID memahami apa yang baru dilakukan bot.
  // - Jika JID adalah owner → inject ke session owner
  // - Jika JID adalah user biasa → inject ke session user tersebut
  // Dengan begitu, saat percakapan berlanjut, Qwen sudah punya konteks proactive.
  const ownerJid = config.ownerLid || config.ownerJid;
  const isOwnerJid = jid === ownerJid;

  try {
    const { prompt: targetSystemPrompt, model: targetModel } = getPersona(jid, isOwnerJid);
    await askAI({
      jid,
      userText: buildContextInjection(jid, analysis, presence),
      systemPrompt: targetSystemPrompt,
      model: targetModel,
    });
    logger.info(
      { targetJid: jid, isOwner: isOwnerJid },
      '💉 proactiveService: konteks diinjeksi ke session JID target'
    );
  } catch (err) {
    logger.warn({ jid, err: err.message }, '⚠️ proactiveService: gagal inject konteks ke session target');
  }

  // ── Step 4: Simpan nextAnalyzeAt ──────────────────────────────────────────
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