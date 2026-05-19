// services/contextEnricher.js
// Fitur 6 · Event Awareness + Fitur 3 · Time-Aware Greeting
//
// Mengumpulkan semua konteks tambahan yang diinjeksi ke prompt proactiveService:
//
// [Fitur 6] Event Awareness:
//   - Daftar hari besar nasional / internasional
//   - Deteksi event dari userProfile (wisuda, ulang tahun, dll)
//   - Cocokkan dengan tanggal sekarang → jika relevan, injeksi ke prompt
//
// [Fitur 3] Time-Aware Greeting:
//   - Waktu lokal user (pagi/siang/sore/malam)
//   - Pola keaktifan user berdasarkan chatHistory (jam berapa biasanya aktif)
//   - Tone yang disarankan sesuai waktu dan pola
//   - Deteksi absen: user biasanya aktif jam ini tapi tidak ada pesan hari ini

import logger from '../utils/logger.js';

// ─── Fitur 3: Time-Aware ──────────────────────────────────────────────────────

const WIB_OFFSET = 7 * 60; // UTC+7

/**
 * Dapatkan jam lokal user (WIB) dan label waktu.
 * @returns {{ hour: number, label: string, tone: string }}
 */
function getTimeContext() {
  const nowUTC = new Date();
  const wibMinutes = nowUTC.getUTCHours() * 60 + nowUTC.getUTCMinutes() + WIB_OFFSET;
  const hour = Math.floor((wibMinutes % (24 * 60)) / 60);

  let label, tone;

  if (hour >= 5 && hour < 10) {
    label = 'pagi';
    tone = 'semangat dan hangat — cocok untuk sapaan pembuka hari';
  } else if (hour >= 10 && hour < 13) {
    label = 'siang (menjelang tengah hari)';
    tone = 'santai tapi aktif — cocok untuk topik ringan atau follow-up';
  } else if (hour >= 13 && hour < 16) {
    label = 'siang (setelah makan)';
    tone = 'ringan — user mungkin sedang istirahat atau santai sebentar';
  } else if (hour >= 16 && hour < 19) {
    label = 'sore';
    tone = 'hangat dan relaxed — cocok untuk ngobrol santai atau cerita hari ini';
  } else if (hour >= 19 && hour < 22) {
    label = 'malam';
    tone = 'santai dan akrab — user biasanya lebih terbuka dan punya waktu';
  } else {
    label = 'larut malam';
    tone = 'lembut dan singkat — jangan topik berat, user mungkin mau istirahat';
  }

  return { hour, label, tone };
}

/**
 * Analisa pola keaktifan user dari chatHistory.
 * Hitung jam mana user paling sering mengirim pesan.
 *
 * @param {object[]} history - chatHistory dari getHistory(jid)
 * @returns {{ peakHours: number[], isUsuallyActiveNow: boolean }}
 */
function analyzeActivityPattern(history) {
  if (!history?.length) return { peakHours: [], isUsuallyActiveNow: false };

  // Hitung frekuensi per jam dari pesan user
  const hourCounts = new Array(24).fill(0);
  for (const msg of history) {
    if (msg.role !== 'user') continue;
    const wibMinutes = new Date(msg.timestamp).getUTCHours() * 60
      + new Date(msg.timestamp).getUTCMinutes() + WIB_OFFSET;
    const hour = Math.floor((wibMinutes % (24 * 60)) / 60);
    hourCounts[hour]++;
  }

  // Ambil jam dengan aktivitas di atas rata-rata
  const avg = hourCounts.reduce((a, b) => a + b, 0) / 24;
  const peakHours = hourCounts
    .map((count, hour) => ({ hour, count }))
    .filter(({ count }) => count > avg && count > 0)
    .sort((a, b) => b.count - a.count)
    .slice(0, 3)
    .map(({ hour }) => hour);

  // Cek apakah sekarang adalah jam puncak keaktifan user
  const { hour: currentHour } = getTimeContext();
  const isUsuallyActiveNow = peakHours.some(
    (peak) => Math.abs(peak - currentHour) <= 1
  );

  // Deteksi absen: user biasanya aktif jam ini, tapi tidak ada pesan hari ini
  const today = new Date().toISOString().slice(0, 10);
  const hasMessageToday = history.some(
    (msg) => msg.role === 'user' && msg.timestamp.startsWith(today)
  );

  return { peakHours, isUsuallyActiveNow, hasMessageToday };
}

/**
 * Format time context untuk prompt.
 * @param {object[]} history
 * @returns {string}
 */
function formatTimeContext(history) {
  const { label, tone } = getTimeContext();
  const { peakHours, isUsuallyActiveNow, hasMessageToday } = analyzeActivityPattern(history);

  const lines = ['=== KONTEKS WAKTU ==='];
  lines.push(`Waktu sekarang: ${label} (WIB)`);
  lines.push(`Tone yang disarankan: ${tone}`);

  if (peakHours.length > 0) {
    const peakStr = peakHours.map((h) => `${h}:00`).join(', ');
    lines.push(`Jam paling aktif user: ${peakStr}`);
  }

  if (isUsuallyActiveNow && !hasMessageToday) {
    lines.push(`⚠️ User biasanya aktif jam ini, tapi belum ada pesan hari ini → pertimbangkan check-in ringan`);
  } else if (isUsuallyActiveNow) {
    lines.push(`✅ Ini jam aktif user — peluang bagus untuk berinteraksi`);
  }

  return lines.join('\n');
}

// ─── Fitur 6: Event Awareness ─────────────────────────────────────────────────

/**
 * Daftar hari besar yang relevan (Indonesia + umum).
 * Format: { month: 1-12, day: 1-31, name: string }
 */
const NATIONAL_EVENTS = [
  { month: 1,  day: 1,  name: 'Tahun Baru' },
  { month: 2,  day: 14, name: 'Hari Valentine' },
  { month: 4,  day: 21, name: 'Hari Kartini' },
  { month: 5,  day: 2,  name: 'Hari Pendidikan Nasional' },
  { month: 5,  day: 20, name: 'Hari Kebangkitan Nasional' },
  { month: 6,  day: 1,  name: 'Hari Lahir Pancasila' },
  { month: 8,  day: 17, name: 'Hari Kemerdekaan Indonesia' },
  { month: 10, day: 28, name: 'Hari Sumpah Pemuda' },
  { month: 11, day: 10, name: 'Hari Pahlawan' },
  { month: 12, day: 22, name: 'Hari Ibu' },
  { month: 12, day: 25, name: 'Hari Natal' },
  { month: 12, day: 31, name: 'Malam Tahun Baru' },
];

/**
 * Cek apakah hari ini ada hari besar.
 * Juga cek 1 hari sebelum untuk persiapan.
 *
 * @returns {{ today: string[], tomorrow: string[] }}
 */
function checkNationalEvents() {
  const now = new Date();
  const wibNow = new Date(now.getTime() + WIB_OFFSET * 60 * 1000);
  const month = wibNow.getUTCMonth() + 1;
  const day = wibNow.getUTCDate();

  const today = NATIONAL_EVENTS
    .filter((e) => e.month === month && e.day === day)
    .map((e) => e.name);

  const tomorrow = NATIONAL_EVENTS
    .filter((e) => e.month === month && e.day === day + 1)
    .map((e) => e.name);

  return { today, tomorrow };
}

/**
 * Cari event personal dari userProfile yang relevan dengan tanggal sekarang.
 * Misalnya: profil menyebut "wisuda bulan ini" atau "ulang tahun minggu depan".
 *
 * @param {object|null} userProfile
 * @returns {string[]}
 */
function checkPersonalEvents(userProfile) {
  if (!userProfile?.goals?.length) return [];

  const now = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
  const keywords = ['wisuda', 'ulang tahun', 'anniversary', 'nikah', 'pernikahan',
    'ujian', 'skripsi', 'sidang', 'interview', 'test', 'tes', 'lomba', 'kompetisi'];

  return userProfile.goals.filter((goal) =>
    keywords.some((kw) => goal.toLowerCase().includes(kw))
  );
}

/**
 * Format event awareness untuk prompt.
 * @param {object|null} userProfile
 * @returns {string}
 */
function formatEventContext(userProfile) {
  const { today, tomorrow } = checkNationalEvents();
  const personal = checkPersonalEvents(userProfile);

  const lines = [];

  if (today.length > 0 || tomorrow.length > 0 || personal.length > 0) {
    lines.push('=== KONTEKS EVENT ===');
    if (today.length > 0)    lines.push(`Hari besar hari ini: ${today.join(', ')} → pertimbangkan ucapan yang relevan`);
    if (tomorrow.length > 0) lines.push(`Besok: ${tomorrow.join(', ')} → bisa disinggung secara natural`);
    if (personal.length > 0) lines.push(`Event personal user yang mungkin relevan: ${personal.join(', ')}`);
  }

  return lines.join('\n');
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Build semua konteks tambahan untuk diinjeksi ke prompt proactiveService.
 * Menggabungkan: time context + event awareness + follow-up pending.
 *
 * @param {object} options
 * @param {object[]}     options.history     - chatHistory JID
 * @param {object|null}  options.userProfile - dari getUserProfile(jid)
 * @param {string}       [options.followUps] - dari formatFollowUpsForPrompt(jid)
 * @returns {string} blok konteks siap injeksi ke prompt
 */
export function buildEnrichedContext({ history, userProfile, followUps = '' }) {
  const parts = [];

  const timeCtx = formatTimeContext(history);
  if (timeCtx) parts.push(timeCtx);

  const eventCtx = formatEventContext(userProfile);
  if (eventCtx) parts.push(eventCtx);

  if (followUps) parts.push(followUps);

  return parts.join('\n\n');
}