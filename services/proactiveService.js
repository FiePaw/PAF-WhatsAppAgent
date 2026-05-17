// services/proactiveService.js
// Service analisa chatHistory setiap 1 jam.
// Qwen memutuskan: apakah perlu kirim pesan, kapan analisa boleh dilakukan lagi,
// apakah topik cukup penting untuk dikirim meski user offline.
//
// Skema keputusan Qwen:
// ┌──────────────┬───────────────┬────────────────────────────────────────────┐
// │  isOnline    │  shouldSend   │  Tindakan                                  │
// ├──────────────┼───────────────┼────────────────────────────────────────────┤
// │  true        │  true         │  Kirim pesan                               │
// │  true        │  false        │  Simpan nextAnalyzeAt, skip                │
// │  false       │  true+urgent  │  Kirim pesan (topik penting)               │
// │  false       │  true (biasa) │  Skip, simpan nextAnalyzeAt               │
// │  false       │  false        │  Skip, simpan nextAnalyzeAt               │
// └──────────────┴───────────────┴────────────────────────────────────────────┘

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
 * Format: "30m" | "1h" | "2h" | "3h" | "6h" | "12h" | "24h" | null
 * null → default 1 jam
 */
function resolveNextAnalyzeAt(nextAnalyzeIn) {
  if (!nextAnalyzeIn) {
    return new Date(Date.now() + 60 * 60 * 1000).toISOString();
  }
  const match = nextAnalyzeIn.match(/^(\d+)(m|h)$/);
  if (!match) {
    logger.warn({ nextAnalyzeIn }, '⚠️ proactiveService: format nextAnalyzeIn tidak dikenal, pakai default 1h');
    return new Date(Date.now() + 60 * 60 * 1000).toISOString();
  }
  const value = parseInt(match[1]);
  const unit = match[2];
  const ms = unit === 'm' ? value * 60 * 1000 : value * 60 * 60 * 1000;
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
    ? 'Status online: Tidak diketahui (data tidak tersedia / user sembunyikan last seen)'
    : [
        `Status online: ${presence.isOnline ? '🟢 ONLINE sekarang' : '🔴 OFFLINE'}`,
        `(${presence.lastKnownPresence})`,
        presence.lastSeen
          ? `· Terakhir online: ${new Date(presence.lastSeen).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })}`
          : '',
      ].join(' ');

  const now = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });

  return `Kamu adalah asisten WhatsApp bot yang cerdas, empatik, dan proaktif. Tugasmu menganalisa riwayat percakapan dan memutuskan apakah perlu mengirim pesan inisiatif — dengan mempertimbangkan konteks percakapan DAN status online user saat ini.

=== WAKTU SEKARANG ===
${now}

=== DATA KONTAK ===
JID: ${jid}
Pesan pertama tercatat: ${new Date(firstSent).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })}
Pesan terakhir tercatat: ${new Date(lastSent).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })}
Total pesan: ${history.length}
${presenceInfo}

=== RIWAYAT PERCAKAPAN ===
${conversation}

=== PANDUAN KEPUTUSAN ===
• Jika user ONLINE dan ada history chat:
  - Boleh membuka topik lama yang belum selesai
  - Boleh membuat topik baru yang relevan dari analisa history (saran, info menarik, pertanyaan follow-up)
  - Jangan terlihat memaksa atau spam

• Jika user OFFLINE:
  - Secara default JANGAN kirim (shouldSend: false) kecuali topik dianggap URGENT
  - Topik URGENT: pengingat jadwal/rencana user, mood user yang perlu diperhatikan, informasi penting dari topik sebelumnya, kemauan/niat user yang perlu diingatkan
  - Jika urgent, set isUrgent: true dan shouldSend: true

• Jika status TIDAK DIKETAHUI → perlakukan seperti offline (lebih aman)

=== FORMAT RESPONSE ===
Tentukan nextAnalyzeIn: berapa lama bot tunggu sebelum menganalisa kontak ini lagi.
Pilihan: "30m" | "1h" | "2h" | "3h" | "6h" | "12h" | "24h" | null (null = default 1 jam)

Balas HANYA dengan JSON valid berikut (tanpa komentar, tanpa markdown backtick):
{
  "shouldSend": true | false,
  "isUrgent": true | false,
  "message": "pesan yang akan dikirim (string kosong jika shouldSend false)",
  "reason": "alasan singkat keputusan kamu",
  "nextAnalyzeIn": "1h",
  "contextSummary": "ringkasan 1-2 kalimat konteks percakapan untuk dilaporkan ke owner"
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
    '@every_5m',
    runProactiveAnalysis,
    { autoStart: true, runOnRegister: false }
  );

  logger.info('🔔 proactiveService: cron job terdaftar (@hourly)');
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