// services/userProfileService.js
// Fitur 10 · Persona Evolution
//
// Setiap sesi selesai, Qwen mengekstrak "profil karakter" user dari chatHistory:
// nama panggilan, kepribadian, hobi, topik favorit, hal sensitif, mood dominan,
// gaya bahasa, dan tujuan/niat yang pernah disebutkan.
//
// Profil disimpan ke collection "userProfiles" (satu dokumen per JID).
// Saat proactiveService atau messageHandler membutuhkan konteks, profil ini
// diinjeksikan ke prompt sebagai bagian dari "Apa yang kamu tahu tentang user ini".
//
// Struktur dokumen userProfile:
// {
//   jid:         string,
//   nickname:    string,          // nama panggilan user
//   personality: string,          // deskripsi kepribadian
//   hobbies:     string[],        // hobi / minat
//   topics:      string[],        // topik yang sering/suka dibahas
//   sensitive:   string[],        // hal sensitif yang harus dihindari
//   mood:        string,          // mood dominan terakhir
//   language:    string,          // gaya bahasa (formal/casual/gaul/campuran)
//   goals:       string[],        // tujuan/niat/rencana yang pernah disebutkan
//   summary:     string,          // ringkasan bebas 2-3 kalimat
//   updatedAt:   ISO string,
// }

import db from './db.js';
import { askAI } from './aiService.js';
import logger from '../utils/logger.js';

const COLLECTION = 'userProfiles';

// ─── DB helpers ───────────────────────────────────────────────────────────────

export function getUserProfile(jid) {
  return db.findOne(COLLECTION, { jid }) ?? null;
}

async function saveUserProfile(jid, profile) {
  await db.upsert(COLLECTION, { jid }, {
    ...profile,
    jid,
    updatedAt: new Date().toISOString(),
  });
}

// ─── Format profil untuk diinjeksi ke prompt ─────────────────────────────────

/**
 * Format profil user menjadi teks konteks untuk prompt Qwen.
 * Dipanggil dari proactiveService dan messageHandler.
 *
 * @param {string} jid
 * @returns {string} teks konteks atau string kosong jika tidak ada profil
 */
export function formatUserProfileForPrompt(jid) {
  const profile = getUserProfile(jid);
  if (!profile) return '';

  const lines = ['=== PROFIL USER ==='];

  if (profile.nickname)    lines.push(`Nama panggilan: ${profile.nickname}`);
  if (profile.personality) lines.push(`Kepribadian: ${profile.personality}`);
  if (profile.mood)        lines.push(`Mood dominan terakhir: ${profile.mood}`);
  if (profile.language)    lines.push(`Gaya bahasa: ${profile.language}`);
  if (profile.hobbies?.length)   lines.push(`Hobi / minat: ${profile.hobbies.join(', ')}`);
  if (profile.topics?.length)    lines.push(`Topik favorit: ${profile.topics.join(', ')}`);
  if (profile.goals?.length)     lines.push(`Tujuan / rencana: ${profile.goals.join(', ')}`);
  if (profile.sensitive?.length) lines.push(`Hal sensitif (hindari): ${profile.sensitive.join(', ')}`);
  if (profile.summary)    lines.push(`\nRingkasan: ${profile.summary}`);

  const updatedAt = profile.updatedAt
    ? new Date(profile.updatedAt).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })
    : '-';
  lines.push(`\n(Profil terakhir diperbarui: ${updatedAt})`);

  return lines.join('\n');
}

// ─── Core: ekstrak profil dari history ───────────────────────────────────────

/**
 * Minta Qwen mengekstrak profil user dari chatHistory.
 * Dipanggil fire-and-forget setelah sesi chat selesai (dari messageHandler).
 *
 * @param {string} jid
 * @param {object[]} history - array pesan dari chatHistoryService.getHistory()
 */
export async function buildUserProfile(jid, history) {
  if (!history?.length) return;

  // Minimal 4 pesan sebelum mulai ekstrak — agar ada cukup data
  if (history.length < 4) return;

  const conversation = history
    .slice(-30) // ambil 30 pesan terakhir
    .map((e) => {
      const roleLabel = e.role === 'bot' ? 'Bot' : 'User';
      return `${roleLabel}: ${e.text}`;
    })
    .join('\n');

  const existingProfile = getUserProfile(jid);
  const existingContext = existingProfile
    ? `\nProfil sebelumnya (perbarui jika ada info baru):\n${JSON.stringify(existingProfile, null, 2)}`
    : '';

  const prompt = `Kamu adalah sistem analisa percakapan. Baca percakapan WhatsApp berikut dan ekstrak profil karakter user.${existingContext}

=== PERCAKAPAN ===
${conversation}

=== TUGAS ===
Ekstrak informasi berikut dari percakapan di atas. Jika informasi tidak tersedia, gunakan null atau array kosong [].
Jika ada profil sebelumnya, gabungkan dengan info baru — jangan hapus info lama kecuali ada yang bertentangan.

Balas HANYA dengan JSON valid (tanpa komentar, tanpa markdown backtick):
{
  "nickname": "nama panggilan user jika disebutkan, atau null",
  "personality": "deskripsi singkat kepribadian user (1-2 kalimat)",
  "hobbies": ["hobi atau minat yang disebutkan"],
  "topics": ["topik yang sering atau suka dibahas"],
  "sensitive": ["hal sensitif yang perlu dihindari"],
  "mood": "mood dominan dalam percakapan ini (senang/sedih/excited/stress/santai/dll)",
  "language": "gaya bahasa user (formal/casual/gaul/campuran)",
  "goals": ["tujuan, niat, atau rencana yang pernah disebutkan"],
  "summary": "ringkasan 2-3 kalimat tentang siapa user ini berdasarkan percakapan"
}`;

  try {
    const rawResponse = await askAI({
      jid: `profile_builder_${jid}`,
      userText: prompt,
      systemPrompt: 'Kamu adalah sistem ekstraksi profil. Balas HANYA dengan JSON valid sesuai format. Tidak ada teks lain.',
      forceNew: true,
    });

    const cleaned = rawResponse.replace(/```json|```/gi, '').trim();
    const profile = JSON.parse(cleaned);

    await saveUserProfile(jid, profile);
    logger.info({ jid }, '👤 userProfile: profil berhasil diperbarui');
  } catch (err) {
    logger.warn({ jid, err: err.message }, '⚠️ userProfile: gagal ekstrak profil');
  }
}