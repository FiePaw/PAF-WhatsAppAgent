// services/botBrain.js
// Orchestrator tunggal — menggantikan proactiveService, followUpService,
// userProfileService (siklus cron), dan logika event dari contextEnricher.
//
// Satu otak, satu keputusan per JID per siklus:
//   1. Kumpulkan semua data (history, profil, follow-up, presence, waktu)
//   2. Kirim ke Qwen SEKALI → Qwen return keputusan holistik
//   3. BotBrain eksekusi keputusan
//
// Anti-spam berlapis:
//   - Read receipt: jika pesan terakhir bot belum dibaca < 24 jam → skip proactive
//   - Follow-up: bypass read-check (sudah dijanjikan ke user)
//   - Satu pesan per siklus per JID
//   - nextAnalyzeIn: Qwen tentukan kapan cek lagi (max 1 jam)
//
// Profil user diperbarui setiap 1 jam (siklus hourly terpisah di dalam botBrain).
//
// Collections DB yang dipakai:
//   brainState      → { jid, nextAnalyzeAt, lastSentAt, lastSentMsgId, lastReadAt }
//   followUpEvents  → { jid, event, context, followUpAt, done, createdAt }
//   userProfiles    → { jid, nickname, personality, ... }

import cronService from './cronService.js';
import { getActiveJids, getAllKnownJids, getHistory, pruneAllOldMessages } from './chatHistoryService.js';
import { getPresence, subscribePresence, subscribeAll } from './presenceService.js';
import { askAI } from './aiService.js';
import { getPersona } from './personaService.js';
import db from './db.js';
import config from '../config/config.js';
import logger from '../utils/logger.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const BRAIN_STATE   = 'brainState';
const FOLLOWUP_COL  = 'followUpEvents';
const PROFILE_COL   = 'userProfiles';

const WIB_OFFSET    = 7 * 60; // UTC+7 dalam menit
const MAX_ANALYZE_MS = 60 * 60 * 1000;        // cap nextAnalyzeIn: 1 jam
const UNREAD_BLOCK_MS = 24 * 60 * 60 * 1000;  // blokir proactive jika belum dibaca < 24 jam
const PROFILE_UPDATE_INTERVAL_MS = 60 * 60 * 1000; // perbarui profil tiap 1 jam

// ─── State helpers ────────────────────────────────────────────────────────────

function getState(jid) {
  return db.findOne(BRAIN_STATE, { jid }) ?? {
    jid,
    nextAnalyzeAt:  null,
    lastSentAt:     null,
    lastSentMsgId:  null,   // message ID terakhir yang dikirim bot (untuk track receipt)
    lastReadAt:     null,   // kapan pesan terakhir bot dibaca user
  };
}

async function saveState(jid, updates) {
  await db.upsert(BRAIN_STATE, { jid }, updates);
}

function resolveNextAnalyzeAt(nextAnalyzeIn) {
  if (!nextAnalyzeIn) return new Date(Date.now() + 15 * 60 * 1000).toISOString();
  const match = nextAnalyzeIn.match(/^(\d+)(m|h)$/);
  if (!match) return new Date(Date.now() + 15 * 60 * 1000).toISOString();
  const ms = Math.min(
    parseInt(match[1]) * (match[2] === 'm' ? 60_000 : 3_600_000),
    MAX_ANALYZE_MS
  );
  return new Date(Date.now() + ms).toISOString();
}

function isAnalysisAllowed(jid) {
  const state = getState(jid);
  if (!state.nextAnalyzeAt) return true;
  return new Date().toISOString() >= state.nextAnalyzeAt;
}

// ─── Read Receipt ─────────────────────────────────────────────────────────────

/**
 * Update lastReadAt saat Baileys melaporkan pesan dibaca.
 * Dipanggil dari bot.js event 'message-receipt.update'.
 *
 * @param {object[]} receipts - array { key, receipt } dari Baileys
 */
export async function handleReceiptUpdate(receipts) {
  for (const { key, receipt } of receipts) {
    // read receipt = readTimestamp ada
    if (!receipt?.readTimestamp) continue;

    const jid = key.remoteJid;
    if (!jid || jid === 'status@broadcast') continue;

    const state = getState(jid);
    // Hanya update jika receipt ini untuk pesan yang bot kirim terakhir
    if (state.lastSentMsgId && key.id === state.lastSentMsgId) {
      const readAt = new Date(receipt.readTimestamp * 1000).toISOString();
      await saveState(jid, { lastReadAt: readAt });
      logger.debug({ jid, readAt }, '👁️ botBrain: pesan terakhir bot sudah dibaca');
    }
  }
}

/**
 * Cek apakah pesan terakhir bot sudah dibaca atau sudah > 24 jam sejak dikirim.
 * Jika belum dibaca dan belum 24 jam → blokir proactive (tapi tidak blokir follow-up).
 *
 * @param {string} jid
 * @returns {{ blocked: boolean, reason: string }}
 */
function checkReadStatus(jid) {
  const state = getState(jid);

  // Belum pernah kirim → tidak diblokir
  if (!state.lastSentAt) return { blocked: false, reason: 'belum pernah kirim' };

  // Sudah dibaca → tidak diblokir
  if (state.lastReadAt && state.lastReadAt >= state.lastSentAt) {
    return { blocked: false, reason: 'sudah dibaca' };
  }

  // Belum dibaca — cek umur pesan
  const msSinceSent = Date.now() - new Date(state.lastSentAt).getTime();
  if (msSinceSent < UNREAD_BLOCK_MS) {
    const hoursLeft = Math.ceil((UNREAD_BLOCK_MS - msSinceSent) / 3_600_000);
    return { blocked: true, reason: `belum dibaca, ${hoursLeft} jam lagi baru bisa kirim` };
  }

  // Sudah > 24 jam belum dibaca → lepaskan blokir (user mungkin tidak aktif)
  return { blocked: false, reason: 'belum dibaca tapi sudah > 24 jam' };
}

// ─── User Profile ─────────────────────────────────────────────────────────────

function getUserProfile(jid) {
  return db.findOne(PROFILE_COL, { jid }) ?? null;
}

/**
 * Perbarui profil user via Qwen. Berjalan setiap 1 jam.
 * @param {string} jid
 * @param {object[]} history
 */
async function updateUserProfile(jid, history) {
  if (!history?.length || history.length < 4) return;

  const existing = getUserProfile(jid);

  // Skip jika profil baru diperbarui < 1 jam yang lalu
  if (existing?.updatedAt) {
    const age = Date.now() - new Date(existing.updatedAt).getTime();
    if (age < PROFILE_UPDATE_INTERVAL_MS) return;
  }

  const conversation = history.slice(-30)
    .map((e) => `${e.role === 'bot' ? 'Bot' : 'User'}: ${e.text}`)
    .join('\n');

  const existingCtx = existing
    ? `\nProfil sebelumnya (perbarui jika ada info baru):\n${JSON.stringify(existing, null, 2)}`
    : '';

  const prompt = `Kamu adalah sistem analisa percakapan. Baca percakapan WhatsApp berikut dan ekstrak profil karakter user.${existingCtx}

=== PERCAKAPAN ===
${conversation}

Ekstrak informasi berikut. Gunakan null atau [] jika tidak tersedia. Gabungkan dengan profil lama jika ada.

Balas HANYA dengan JSON valid (tanpa komentar, tanpa markdown backtick):
{
  "nickname":    "nama panggilan user atau null",
  "personality": "deskripsi kepribadian singkat",
  "hobbies":     ["hobi/minat"],
  "topics":      ["topik favorit"],
  "sensitive":   ["hal sensitif yang dihindari"],
  "mood":        "mood dominan (senang/sedih/excited/stress/santai/dll)",
  "language":    "gaya bahasa (formal/casual/gaul/campuran)",
  "goals":       ["tujuan/niat/rencana yang disebutkan"],
  "summary":     "ringkasan 2-3 kalimat tentang siapa user ini"
}`;

  try {
    const raw = await askAI({
      jid: `profile_builder_${jid}`,
      userText: prompt,
      systemPrompt: 'Kamu adalah sistem ekstraksi profil. Balas HANYA dengan JSON valid. Tidak ada teks lain.',
      forceNew: true,
    });

    const profile = JSON.parse(raw.replace(/```json|```/gi, '').trim());
    await db.upsert(PROFILE_COL, { jid }, { ...profile, jid, updatedAt: new Date().toISOString() });
    logger.info({ jid }, '👤 botBrain: profil user diperbarui');
  } catch (err) {
    logger.warn({ jid, err: err.message }, '⚠️ botBrain: gagal perbarui profil');
  }
}

function formatProfileForPrompt(jid) {
  const p = getUserProfile(jid);
  if (!p) return '';
  const lines = ['=== PROFIL USER ==='];
  if (p.nickname)    lines.push(`Nama panggilan: ${p.nickname}`);
  if (p.personality) lines.push(`Kepribadian: ${p.personality}`);
  if (p.mood)        lines.push(`Mood terakhir: ${p.mood}`);
  if (p.language)    lines.push(`Gaya bahasa: ${p.language}`);
  if (p.hobbies?.length)   lines.push(`Hobi: ${p.hobbies.join(', ')}`);
  if (p.topics?.length)    lines.push(`Topik favorit: ${p.topics.join(', ')}`);
  if (p.goals?.length)     lines.push(`Tujuan/rencana: ${p.goals.join(', ')}`);
  if (p.sensitive?.length) lines.push(`Hal sensitif (hindari): ${p.sensitive.join(', ')}`);
  if (p.summary)    lines.push(`\nRingkasan: ${p.summary}`);
  return lines.join('\n');
}

// ─── Follow-up ────────────────────────────────────────────────────────────────

function getDueFollowUps(jid) {
  const now = new Date().toISOString();
  return db.find(FOLLOWUP_COL, { jid }).filter((e) => !e.done && e.followUpAt <= now);
}

function getPendingFollowUps(jid) {
  return db.find(FOLLOWUP_COL, { jid }).filter((e) => !e.done);
}

async function markFollowUpDone(id) {
  await db.update(FOLLOWUP_COL, { _id: id }, { done: true });
}

/**
 * Ekstrak event dari history dan simpan ke followUpEvents.
 * Dipanggil dalam siklus hourly botBrain (bukan per chat).
 */
async function extractFollowUps(jid, history) {
  if (!history?.length) return;

  const userMessages = history
    .filter((e) => e.role === 'user')
    .slice(-20)
    .map((e) => {
      const time = new Date(e.timestamp).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
      return `[${time}] ${e.text}`;
    })
    .join('\n');

  const now = new Date().toISOString();
  const nowLocale = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });

  const prompt = `Kamu adalah sistem deteksi event dari percakapan WhatsApp. Temukan event/rencana/niat user yang memiliki dimensi waktu.

Waktu sekarang: ${nowLocale}

=== PESAN USER ===
${userMessages}

Jika tidak ada event, kembalikan array kosong.
followUpAt dalam ISO 8601. Waktu sekarang: ${now}

Balas HANYA dengan JSON valid:
{ "events": [{ "event": "deskripsi", "context": "kutipan", "followUpAt": "ISO" }] }`;

  try {
    const raw = await askAI({
      jid: `followup_extractor_${jid}`,
      userText: prompt,
      systemPrompt: 'Kamu adalah sistem deteksi event. Balas HANYA dengan JSON valid. Tidak ada teks lain.',
      forceNew: true,
    });

    const result = JSON.parse(raw.replace(/```json|```/gi, '').trim());
    if (!result.events?.length) return;

    const existing = db.find(FOLLOWUP_COL, { jid }).map((e) => e.event);
    let saved = 0;
    for (const ev of result.events) {
      if (existing.includes(ev.event)) continue;
      await db.insert(FOLLOWUP_COL, {
        jid, event: ev.event, context: ev.context ?? '',
        followUpAt: ev.followUpAt, done: false, createdAt: new Date().toISOString(),
      });
      saved++;
    }
    if (saved > 0) logger.info({ jid, saved }, '📅 botBrain: follow-up event tersimpan');
  } catch (err) {
    logger.warn({ jid, err: err.message }, '⚠️ botBrain: gagal ekstrak follow-up');
  }
}

function formatFollowUpsForPrompt(jid) {
  const pending = getPendingFollowUps(jid);
  if (!pending.length) return '';
  const lines = ['=== FOLLOW-UP TERJADWAL ==='];
  for (const e of pending) {
    const t = new Date(e.followUpAt).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
    lines.push(`• "${e.event}" → dijadwalkan: ${t}`);
    if (e.context) lines.push(`  Konteks: ${e.context}`);
  }
  return lines.join('\n');
}

// ─── Time-Aware Context ───────────────────────────────────────────────────────

function buildTimeContext(history) {
  const nowUTC = new Date();
  const wibMin = nowUTC.getUTCHours() * 60 + nowUTC.getUTCMinutes() + WIB_OFFSET;
  const hour = Math.floor((wibMin % (24 * 60)) / 60);

  const toneMap = [
    [5,  10, 'pagi',                  'semangat dan hangat'],
    [10, 13, 'siang menjelang tengah hari', 'santai tapi aktif'],
    [13, 16, 'siang setelah makan',   'ringan, user mungkin istirahat'],
    [16, 19, 'sore',                  'hangat dan relaxed'],
    [19, 22, 'malam',                 'santai dan akrab'],
    [22, 29, 'larut malam',           'lembut dan singkat'],
  ];

  let label = 'tidak diketahui', tone = '';
  for (const [from, to, lbl, tn] of toneMap) {
    if (hour >= from && hour < to) { label = lbl; tone = tn; break; }
  }

  // Deteksi jam puncak aktif user
  const hourCounts = new Array(24).fill(0);
  for (const msg of history) {
    if (msg.role !== 'user') continue;
    const wm = new Date(msg.timestamp).getUTCHours() * 60
      + new Date(msg.timestamp).getUTCMinutes() + WIB_OFFSET;
    hourCounts[Math.floor((wm % (24 * 60)) / 60)]++;
  }
  const avg = hourCounts.reduce((a, b) => a + b, 0) / 24;
  const peakHours = hourCounts
    .map((c, h) => ({ h, c }))
    .filter(({ c }) => c > avg && c > 0)
    .sort((a, b) => b.c - a.c)
    .slice(0, 3)
    .map(({ h }) => h);

  const isActiveNow = peakHours.some((p) => Math.abs(p - hour) <= 1);
  const today = new Date().toISOString().slice(0, 10);
  const hasToday = history.some((m) => m.role === 'user' && m.timestamp.startsWith(today));

  const lines = [
    '=== KONTEKS WAKTU ===',
    `Waktu sekarang: ${label} (WIB) · Tone disarankan: ${tone}`,
  ];
  if (peakHours.length) lines.push(`Jam aktif user: ${peakHours.map((h) => `${h}:00`).join(', ')}`);
  if (isActiveNow && !hasToday) lines.push('⚠️ User biasanya aktif jam ini tapi belum ada pesan hari ini → pertimbangkan check-in');
  else if (isActiveNow) lines.push('✅ Jam aktif user — peluang bagus untuk berinteraksi');

  return lines.join('\n');
}

// ─── Main Decision Prompt ─────────────────────────────────────────────────────

function buildBrainPrompt({ jid, history, presence, profileText, followUpsText, timeText, readStatus }) {
  const firstSent = history[0]?.firstSent ?? '-';
  const lastSent  = history[history.length - 1]?.lastSent ?? '-';
  const now = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });

  const msSinceLast = lastSent !== '-' ? Date.now() - new Date(lastSent).getTime() : null;
  const timeSinceLast = !msSinceLast ? 'tidak diketahui'
    : msSinceLast < 60_000 ? 'baru saja'
    : msSinceLast < 3_600_000 ? `${Math.floor(msSinceLast / 60_000)} menit lalu`
    : `${Math.floor(msSinceLast / 3_600_000)} jam lalu`;

  const presenceInfo = presence.isStale
    ? 'Status: Tidak diketahui'
    : `Status: ${presence.isOnline ? '🟢 ONLINE' : '🔴 OFFLINE'} (${presence.lastKnownPresence})${
        presence.lastSeen ? ` · Terakhir online: ${new Date(presence.lastSeen).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })}` : ''
      }`;

  const conversation = history
    .map((e) => {
      const time = new Date(e.timestamp).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
      return `[${time}] ${e.role === 'bot' ? '🤖 Bot' : '👤 User'}: ${e.text}`;
    })
    .join('\n');

  const contextBlocks = [profileText, timeText, followUpsText]
    .filter(Boolean).join('\n\n');

  return `Kamu adalah teman dekat yang sedang menganalisa percakapan WhatsApp dan membuat keputusan terbaik secara holistik.

=== WAKTU SEKARANG ===
${now}

=== INFO KONTAK ===
Percakapan dimulai: ${new Date(firstSent).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })}
Pesan terakhir: ${new Date(lastSent).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })} (${timeSinceLast})
Total pesan: ${history.length}
${presenceInfo}
Status baca pesan terakhir bot: ${readStatus}

${contextBlocks ? contextBlocks + '\n\n' : ''}=== RIWAYAT PERCAKAPAN ===
${conversation}

=== TUGAS ===
Berdasarkan semua informasi di atas, buat keputusan holistik:

1. Pesan apa yang paling tepat untuk dikirim sekarang? (tulis natural, 1-3 kalimat)
2. Apakah ada follow-up event yang perlu diselesaikan? (dari daftar terjadwal di atas)
3. Perbarui profil user jika ada info baru dari percakapan ini
4. Kapan bot harus menganalisa kontak ini lagi?

Prioritas pesan:
1. Follow-up event yang sudah tiba waktunya
2. Topik yang belum selesai atau pertanyaan yang belum dijawab
3. Respons terhadap sesuatu yang user ceritakan
4. Topik natural berdasarkan profil dan history

=== PANDUAN nextAnalyzeIn ===
- "10m" → user online aktif, pantau respons
- "15m" → situasi aktif, perlu follow-up cepat
- "20m" → baru kirim pesan, tunggu
- "30m" → tidak terlalu mendesak
- "45m" → situasi santai
- "1h"  → maksimal

Balas HANYA dengan JSON valid (tanpa komentar, tanpa markdown backtick):
{
  "message":          "pesan yang dikirim (string kosong jika tidak ada)",
  "resolvedFollowUps": ["_id event yang sudah di-follow-up via pesan ini"],
  "profileUpdates":   { "mood": "...", "goals": ["..."] },
  "nextAnalyzeIn":    "15m",
  "reason":           "alasan singkat keputusan",
  "contextSummary":   "ringkasan 1-2 kalimat konteks percakapan"
}`;
}

// ─── Core: analisa dan eksekusi per JID ───────────────────────────────────────

async function thinkAndActForJid(jid) {
  if (!isAnalysisAllowed(jid)) return;

  const history = getHistory(jid);
  if (!history?.length) return;

  const ownerJid   = config.ownerLid || config.ownerJid;
  const isOwnerJid = jid === ownerJid;
  const { prompt: systemPrompt, model } = getPersona(jid, isOwnerJid);
  const presence   = getPresence(jid);

  // ── Cek follow-up due ─────────────────────────────────────────────────────
  // Follow-up bypass read-check — sudah dijanjikan ke user
  const dueFollowUps = getDueFollowUps(jid);

  // ── Cek read receipt ──────────────────────────────────────────────────────
  const { blocked, reason: readReason } = checkReadStatus(jid);

  if (blocked && dueFollowUps.length === 0) {
    logger.debug({ jid, readReason }, '⏸️ botBrain: pesan belum dibaca & tidak ada follow-up due, skip');
    await saveState(jid, { nextAnalyzeAt: resolveNextAnalyzeAt('15m') });
    return;
  }

  // ── Jika ada follow-up due tapi sedang diblokir — kirim follow-up saja ───
  if (blocked && dueFollowUps.length > 0) {
    logger.info({ jid }, '📅 botBrain: pesan belum dibaca tapi ada follow-up due, kirim follow-up');
    const followUp = dueFollowUps[0];
    await sendSingleFollowUp({ followUp, history, systemPrompt, jid });
    await saveState(jid, { nextAnalyzeAt: resolveNextAnalyzeAt('20m') });
    return;
  }

  // ── Normal: analisa Qwen holistik ─────────────────────────────────────────
  const profileText  = formatProfileForPrompt(jid);
  const followUpsText = formatFollowUpsForPrompt(jid);
  const timeText     = buildTimeContext(history);
  const readStatus   = readReason;

  const prompt = buildBrainPrompt({ jid, history, presence, profileText, followUpsText, timeText, readStatus });

  let decision;
  try {
    const raw = await askAI({
      jid: `brain_${jid}`,
      userText: prompt,
      systemPrompt: 'Kamu adalah sistem keputusan percakapan WhatsApp. Buat keputusan holistik terbaik. Balas HANYA dengan JSON valid sesuai format.',
    });

    decision = JSON.parse(raw.replace(/```json|```/gi, '').trim());

    logger.info(
      { jid, nextAnalyzeIn: decision.nextAnalyzeIn, reason: decision.reason, hasMsg: !!decision.message?.trim() },
      '🧠 botBrain: keputusan selesai'
    );
  } catch (err) {
    logger.error({ jid, err: err.message }, '❌ botBrain: gagal parse keputusan Qwen');
    await saveState(jid, { nextAnalyzeAt: resolveNextAnalyzeAt('30m') });
    return;
  }

  // ── Eksekusi: kirim pesan ─────────────────────────────────────────────────
  let sentMsgId = null;
  if (decision.message?.trim()) {
    const sock = global._sock;
    if (sock) {
      try {
        const result = await sock.sendMessage(jid, { text: decision.message.trim() });
        sentMsgId = result?.key?.id ?? null;
        logger.info({ jid, preview: decision.message.slice(0, 60) }, '📤 botBrain: pesan terkirim');
      } catch (err) {
        logger.error({ jid, err: err.message }, '❌ botBrain: gagal kirim pesan');
      }
    }
  }

  // ── Eksekusi: tandai follow-up selesai ────────────────────────────────────
  if (decision.resolvedFollowUps?.length) {
    for (const id of decision.resolvedFollowUps) {
      await markFollowUpDone(id).catch(() => {});
    }
    logger.debug({ jid, resolved: decision.resolvedFollowUps.length }, '✅ botBrain: follow-up ditandai selesai');
  }

  // ── Eksekusi: perbarui profil parsial dari keputusan Qwen ─────────────────
  if (decision.profileUpdates && Object.keys(decision.profileUpdates).length > 0) {
    const existing = getUserProfile(jid) ?? {};
    await db.upsert(PROFILE_COL, { jid }, {
      ...existing,
      ...decision.profileUpdates,
      jid,
      updatedAt: new Date().toISOString(),
    });
    logger.debug({ jid }, '👤 botBrain: profil diperbarui parsial dari keputusan');
  }

  // ── Inject konteks ke session chat JID ────────────────────────────────────
  try {
    const now = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
    const contextMsg = `[SISTEM - BotBrain Report @ ${now}]\nKontak: ${jid}\nRingkasan: ${decision.contextSummary}\nAlasan: ${decision.reason}\n${decision.message?.trim() ? `Pesan dikirim: "${decision.message}"` : 'Tidak ada pesan dikirim'}`;
    await askAI({ jid, userText: contextMsg, systemPrompt, model });
  } catch (err) {
    logger.warn({ jid, err: err.message }, '⚠️ botBrain: gagal inject konteks ke session');
  }

  // ── Simpan state ──────────────────────────────────────────────────────────
  const stateUpdate = { nextAnalyzeAt: resolveNextAnalyzeAt(decision.nextAnalyzeIn) };
  if (sentMsgId) {
    stateUpdate.lastSentAt    = new Date().toISOString();
    stateUpdate.lastSentMsgId = sentMsgId;
    stateUpdate.lastReadAt    = null; // reset read status untuk pesan baru
  }
  await saveState(jid, stateUpdate);
}

/**
 * Kirim satu follow-up dan catat sentAt.
 */
async function sendSingleFollowUp({ followUp, history, systemPrompt, jid }) {
  const recentHistory = history.slice(-10)
    .map((e) => `${e.role === 'bot' ? 'Bot' : 'User'}: ${e.text}`)
    .join('\n');

  const prompt = `Kamu adalah teman dekat yang melakukan follow-up setelah event yang user ceritakan.

Event: "${followUp.event}"
Konteks: "${followUp.context}"

Riwayat terakhir:
${recentHistory}

Tulis SATU pesan follow-up natural, 1-2 kalimat. Jangan sebut "follow-up".
Balas HANYA dengan teks pesan.`;

  try {
    const message = await askAI({
      jid: `brain_followup_${jid}`,
      userText: prompt,
      systemPrompt,
      forceNew: true,
    });

    if (!message?.trim()) return;

    const sock = global._sock;
    if (!sock) return;

    const result = await sock.sendMessage(jid, { text: message.trim() });
    await markFollowUpDone(followUp._id);

    const sentMsgId = result?.key?.id ?? null;
    await saveState(jid, {
      lastSentAt:    new Date().toISOString(),
      lastSentMsgId: sentMsgId,
      lastReadAt:    null,
    });

    logger.info({ jid, event: followUp.event, preview: message.slice(0, 60) }, '📤 botBrain: follow-up terkirim');
  } catch (err) {
    logger.error({ jid, err: err.message }, '❌ botBrain: gagal kirim follow-up');
  }
}

// ─── Siklus Cron ─────────────────────────────────────────────────────────────

let _cycleCount = 0;

async function runBrainCycle() {
  _cycleCount++;
  logger.info({ cycle: _cycleCount }, '🧠 botBrain: memulai siklus...');

  await pruneAllOldMessages();

  const activeJids = getActiveJids();
  if (!activeJids.length) {
    logger.info('📭 botBrain: tidak ada JID aktif');
    return;
  }

  // Re-subscribe presence setiap siklus (jaga-jaga setelah reconnect)
  await subscribeAll(activeJids);

  // Setiap 6 siklus (~1 jam) → perbarui profil dan ekstrak follow-up
  const doHourlyTasks = _cycleCount % 6 === 0;

  for (const jid of activeJids) {
    try {
      if (doHourlyTasks) {
        const history = getHistory(jid);
        await updateUserProfile(jid, history);
        await extractFollowUps(jid, history);
      }
      await thinkAndActForJid(jid);
      await new Promise((r) => setTimeout(r, 3000));
    } catch (err) {
      logger.error({ jid, err: err.message }, '❌ botBrain: error saat proses JID');
    }
  }

  logger.info({ cycle: _cycleCount }, '✅ botBrain: siklus selesai');
}

// ─── Init ─────────────────────────────────────────────────────────────────────

/**
 * Init botBrain — subscribe presence + daftarkan cron @every_10m.
 * Dipanggil dari bot.js saat koneksi terbuka.
 *
 * @param {string[]} knownJids - dari getAllKnownJids()
 */
export async function initBotBrain(knownJids = []) {
  if (knownJids.length > 0) {
    await subscribeAll(knownJids);
  }

  cronService.register(
    'botBrain',
    '@every_10m',
    runBrainCycle,
    { autoStart: true, runOnRegister: false }
  );

  logger.info('🧠 botBrain: aktif (@every_10m)');
}

/**
 * Subscribe presence untuk JID baru.
 * Dipanggil dari chatHistoryService saat JID pertama kali muncul.
 */
export async function onNewJid(jid) {
  await subscribePresence(jid);
}