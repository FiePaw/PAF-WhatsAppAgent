// services/memoryService.js
// Memory Bank — memori jangka panjang bot tentang owner/user, independen
// dari sesi AI (chatModel/taskModel) yang bisa direset kapan saja.
//
// Latar belakang:
//   Sejak PAF-Model gateway terbaru, sesi AI di SERVER tidak punya TTL
//   otomatis (lihat API_USAGE.md §6.2.1) — tapi BOT tetap membatasi umur
//   sesi lokal (rolling 24 jam, lihat config.sessionTtl) supaya tidak ada
//   sesi menumpuk selamanya. Masalahnya: begitu sesi lokal "dianggap usai"
//   dan dihapus (baik karena TTL maupun mode_fallback dari DeepSeek), AI
//   kehilangan SEMUA konteks kecuali kita simpan sendiri hal-hal penting.
//
//   memoryService adalah lapisan penyimpanan itu — dua jenis data:
//     1. `memories`        → fakta atomik ("Crush user bernama Fie",
//        "Sedang skripsi, target sidang November") — tidak pernah di-
//        overwrite, terus bertambah, di-dedup, dan bisa di-consolidate
//        (dipangkas/gabung oleh AI) kalau sudah terlalu banyak.
//     2. `sessionSummaries` → ringkasan singkat per "akhir sesi" (TTL
//        expired / mode_fallback) — dipakai sebagai konteks "kemarin kita
//        ngobrol soal apa" saat sesi baru dimulai.
//
// Kedua data ini diinjeksi ke system prompt HANYA saat sesi baru dimulai
// (isFirstMessage di aiService.sendRequest) — lihat formatMemoryForPrompt().

import db from './db.js';
import config from '../config/config.js';
import logger from '../utils/logger.js';

const MEMORY_COL  = 'memories';
const SUMMARY_COL = 'sessionSummaries';
// Sama seperti PROFILE_COL di services/botBrain.js — dibaca ulang di sini
// (bukan import silang) agar formatMemoryForPrompt() bisa menggabungkan
// profil yang sudah diekstrak botBrain (siklus per jam: nickname,
// personality, hobbies, goals, summary, dst) dengan memory bank atomik di
// atas. Tanpa ini, fakta yang SUDAH diketahui bot (via userProfiles) tidak
// pernah muncul di system prompt sesi chat baru — persis kejanggalan yang
// dilaporkan: intent session (Qwen, tanpa TTL) "ingat" detail owner, tapi
// sesi chat (DeepSeek) baru terasa amnesia karena hanya baca memory bank
// atomik yang saat itu masih kosong.
const USER_PROFILE_COL = 'userProfiles';

const MAX_MEMORIES_BEFORE_CONSOLIDATE = 40; // di atas ini → trigger consolidation
const MAX_SUMMARIES_KEPT             = 5;   // simpan N ringkasan sesi terakhir per jid
const MAX_FACTS_IN_PROMPT            = 15;  // jumlah fakta yang diinjeksi ke prompt

// ─── Helper: apakah jid ini kontak WhatsApp asli (bukan namespace internal) ─
/**
 * Cek apakah jid adalah JID WhatsApp asli (kontak/grup), bukan jid sintetis
 * internal seperti `profile_builder_...`, `image_desc_...`, `brain_...`, dll.
 * Dipakai untuk menghindari pemborosan panggilan AI pada jid yang tidak
 * punya chatHistory nyata.
 *
 * @param {string} jid
 * @returns {boolean}
 */
export function isRealContactJid(jid) {
  if (!jid || typeof jid !== 'string') return false;
  return jid.endsWith('@s.whatsapp.net') || jid.endsWith('@lid') || jid.endsWith('@g.us');
}

// ─── Fakta atomik ────────────────────────────────────────────────────────

/**
 * Ambil semua fakta memori untuk satu jid, diurutkan: importance desc,
 * lalu recency desc.
 *
 * @param {string} jid
 * @returns {object[]}
 */
export function getMemories(jid) {
  return db.find(MEMORY_COL, { jid }).sort((a, b) => {
    const impDiff = (b.importance ?? 3) - (a.importance ?? 3);
    if (impDiff !== 0) return impDiff;
    return (b.createdAt ?? '').localeCompare(a.createdAt ?? '');
  });
}

/**
 * Simpan satu fakta baru ke memory bank, dengan dedup sederhana
 * (case-insensitive substring match terhadap fakta yang sudah ada).
 *
 * @param {string} jid
 * @param {string} fact
 * @param {string} [category] - mis. 'preference', 'relationship', 'goal', 'sensitive', 'event', 'general'
 * @param {number} [importance] - 1 (kecil) - 5 (sangat penting), default 3
 * @returns {Promise<boolean>} true jika disimpan, false jika duplikat/dilewati
 */
export async function rememberFact(jid, fact, category = 'general', importance = 3) {
  const cleanFact = fact?.trim();
  if (!jid || !cleanFact) return false;

  const existing = getMemories(jid);
  const lower = cleanFact.toLowerCase();
  const isDuplicate = existing.some((m) => {
    const a = m.fact.toLowerCase();
    return a === lower || a.includes(lower) || lower.includes(a);
  });
  if (isDuplicate) {
    logger.debug({ jid, fact: cleanFact.slice(0, 40) }, '⏭️ memoryService: fakta duplikat, dilewati');
    return false;
  }

  await db.insert(MEMORY_COL, {
    jid,
    fact: cleanFact,
    category,
    importance: Math.min(Math.max(parseInt(importance) || 3, 1), 5),
  });

  logger.info({ jid, fact: cleanFact.slice(0, 60), category }, '🧠 memoryService: fakta baru diingat');

  // Trigger consolidation di background jika sudah kepenuhan (fire-and-forget)
  const count = db.count(MEMORY_COL, { jid });
  if (count > MAX_MEMORIES_BEFORE_CONSOLIDATE) {
    consolidateMemories(jid).catch((err) =>
      logger.warn({ jid, err: err.message }, '⚠️ memoryService: gagal consolidate')
    );
  }

  return true;
}

/**
 * Hapus satu fakta memori berdasarkan _id.
 * @param {string} id
 */
export async function forgetFact(id) {
  await db.delete(MEMORY_COL, { _id: id });
}

/**
 * Hapus SEMUA memori (fakta + ringkasan sesi) untuk satu jid.
 * Dipakai misal saat owner benar-benar ingin "lupakan semua" via command.
 * @param {string} jid
 */
export async function forgetAll(jid) {
  const removedFacts = await db.delete(MEMORY_COL, { jid });
  const removedSummaries = await db.delete(SUMMARY_COL, { jid });
  logger.info({ jid, removedFacts, removedSummaries }, '🗑️ memoryService: semua memori jid dihapus');
  return { removedFacts, removedSummaries };
}

/**
 * Consolidation: kalau fakta sudah terlalu banyak, minta AI menggabungkan/
 * memangkas fakta yang tumpang-tindih atau sudah tidak relevan, lalu ganti
 * seluruh set fakta jid ini dengan hasil yang sudah dipadatkan.
 *
 * @param {string} jid
 */
export async function consolidateMemories(jid) {
  const facts = getMemories(jid);
  if (facts.length <= MAX_MEMORIES_BEFORE_CONSOLIDATE) return;

  logger.info({ jid, count: facts.length }, '🧹 memoryService: memulai consolidation...');

  const { askAITool } = await import('./aiService.js');
  const { buildFunctionTool } = await import('../utils/toolCalling.js');

  const factList = facts.map((f, i) => `[${i + 1}] (${f.category}, penting:${f.importance}) ${f.fact}`).join('\n');

  const tool = buildFunctionTool(
    'consolidate_facts',
    'Gabungkan dan padatkan daftar fakta yang tumpang tindih atau sudah tidak relevan menjadi daftar yang lebih ringkas.',
    {
      type: 'object',
      properties: {
        facts: {
          type: 'array',
          description: 'Daftar fakta final setelah dipadatkan (gabungkan yang mirip, buang yang basi/tidak relevan lagi)',
          items: {
            type: 'object',
            properties: {
              fact: { type: 'string', description: 'Isi fakta, kalimat singkat padat' },
              category: { type: 'string', enum: ['preference', 'relationship', 'goal', 'sensitive', 'event', 'general'] },
              importance: { type: 'integer', minimum: 1, maximum: 5 },
            },
            required: ['fact', 'category', 'importance'],
          },
        },
      },
      required: ['facts'],
    }
  );

  try {
    const result = await askAITool({
      jid: `memory_consolidate_${jid}`,
      userText: `Berikut daftar fakta tentang seorang kontak WhatsApp yang sudah terkumpul terlalu banyak (${facts.length} fakta). Padatkan menjadi maksimal ${MAX_MEMORIES_BEFORE_CONSOLIDATE - 10} fakta paling penting — gabungkan yang mirip/tumpang tindih, buang yang basi atau tidak relevan lagi, pertahankan yang unik dan penting.\n\n${factList}`,
      systemPrompt: 'Kamu adalah sistem pemadatan memori. Gunakan tool yang tersedia untuk melaporkan hasil akhir.',
      tools: [tool],
      forceNew: true,
      useMemory: false,
      model: config.ai.taskModel,
    });

    if (result.name === 'consolidate_facts' && Array.isArray(result.args.facts) && result.args.facts.length > 0) {
      await db.delete(MEMORY_COL, { jid });
      for (const f of result.args.facts) {
        await db.insert(MEMORY_COL, {
          jid,
          fact: f.fact,
          category: f.category || 'general',
          importance: Math.min(Math.max(parseInt(f.importance) || 3, 1), 5),
        });
      }
      logger.info({ jid, before: facts.length, after: result.args.facts.length }, '✅ memoryService: consolidation selesai');
    } else {
      logger.warn({ jid }, '⚠️ memoryService: consolidation tidak menghasilkan fakta valid, dilewati');
    }
  } catch (err) {
    logger.error({ jid, err: err.message }, '❌ memoryService: consolidation gagal');
  }
}

// ─── Ringkasan sesi ──────────────────────────────────────────────────────

/**
 * Ambil N ringkasan sesi terakhir untuk jid, terbaru dulu.
 * @param {string} jid
 * @param {number} [limit]
 * @returns {object[]}
 */
export function getRecentSummaries(jid, limit = MAX_SUMMARIES_KEPT) {
  return db.find(SUMMARY_COL, { jid })
    .sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''))
    .slice(0, limit);
}

/**
 * Simpan satu ringkasan sesi baru, lalu pangkas yang lebih lama dari
 * MAX_SUMMARIES_KEPT agar collection tidak tumbuh tanpa batas.
 *
 * @param {string} jid
 * @param {string} summary
 * @param {string} [reason] - alasan sesi diakhiri: 'ttl_expired' | 'mode_fallback' | 'manual_reset'
 */
async function saveSummary(jid, summary, reason = 'ttl_expired') {
  if (!summary?.trim()) return;

  await db.insert(SUMMARY_COL, { jid, summary: summary.trim(), reason });

  // Pangkas ringkasan lama — pertahankan hanya MAX_SUMMARIES_KEPT terbaru
  const all = db.find(SUMMARY_COL, { jid }).sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
  const toRemove = all.slice(MAX_SUMMARIES_KEPT);
  for (const doc of toRemove) {
    await db.delete(SUMMARY_COL, { _id: doc._id });
  }

  logger.info({ jid, reason }, '📝 memoryService: ringkasan sesi disimpan');
}

// ─── Profil dari botBrain (userProfiles) — dibaca ulang untuk gabungan ──
/**
 * Format profil user (diekstrak botBrain.updateUserProfile per jam) untuk
 * diinjeksi bersama memory bank atomik. Pure read — tidak memanggil AI.
 *
 * @param {string} jid
 * @returns {string} blok teks, atau '' jika belum ada profil
 */
function formatUserProfileForPrompt(jid) {
  const p = db.findOne(USER_PROFILE_COL, { jid });
  if (!p) return '';

  const lines = [];
  if (p.nickname)    lines.push(`Nama panggilan: ${p.nickname}`);
  if (p.personality) lines.push(`Kepribadian: ${p.personality}`);
  if (p.mood)         lines.push(`Mood terakhir diketahui: ${p.mood}`);
  if (p.language)     lines.push(`Gaya bahasa: ${p.language}`);
  if (Array.isArray(p.hobbies) && p.hobbies.length)   lines.push(`Hobi: ${p.hobbies.join(', ')}`);
  if (Array.isArray(p.topics) && p.topics.length)     lines.push(`Topik favorit: ${p.topics.join(', ')}`);
  if (Array.isArray(p.goals) && p.goals.length)       lines.push(`Tujuan/rencana: ${p.goals.join(', ')}`);
  if (Array.isArray(p.sensitive) && p.sensitive.length) lines.push(`Hal sensitif (hindari): ${p.sensitive.join(', ')}`);
  if (p.summary)      lines.push(`Ringkasan: ${p.summary}`);

  return lines.length ? lines.join('\n') : '';
}

// ─── Format untuk injeksi ke system prompt ──────────────────────────────

/**
 * Bangun blok teks memori (profil botBrain + fakta atomik + ringkasan sesi)
 * untuk diinjeksi ke system prompt SAAT SESI BARU DIMULAI (isFirstMessage).
 * Pure read — tidak memanggil AI, aman dipakai sinkron dari
 * aiService.sendRequest.
 *
 * @param {string} jid
 * @returns {string} blok teks, atau '' jika tidak ada memori sama sekali
 */
export function formatMemoryForPrompt(jid) {
  if (!jid) return '';

  const profileBlock = formatUserProfileForPrompt(jid);
  const facts = getMemories(jid).slice(0, MAX_FACTS_IN_PROMPT);
  const summaries = getRecentSummaries(jid, 2); // 2 sesi terakhir cukup untuk konteks

  if (!profileBlock && facts.length === 0 && summaries.length === 0) return '';

  const lines = ['=== MEMORI JANGKA PANJANG (dari sesi-sesi sebelumnya) ==='];

  if (profileBlock) {
    lines.push('Profil kontak ini (sudah diketahui bot):');
    lines.push(profileBlock);
  }

  if (summaries.length > 0) {
    lines.push('Ringkasan percakapan terakhir:');
    for (const s of summaries) {
      lines.push(`  • ${s.summary}`);
    }
  }

  if (facts.length > 0) {
    lines.push('Hal-hal penting lain yang kamu tahu tentang kontak ini:');
    for (const f of facts) {
      lines.push(`  • ${f.fact}`);
    }
  }

  lines.push('(Gunakan info di atas secara natural, jangan sebut "menurut memori/data" — seolah kamu memang ingat.)');

  return lines.join('\n');
}

// ─── Ringkas & simpan saat sesi berakhir ────────────────────────────────

/**
 * Dipanggil saat sesi AI untuk satu jid dianggap "berakhir" — baik karena
 * TTL lokal tercapai (sessionStore._cleanup) maupun mode_fallback dari
 * DeepSeek (aiService.sendRequest). Mengambil chatHistory terbaru, minta
 * taskModel mengekstrak fakta baru + ringkasan sesi, lalu simpan ke memory
 * bank. Fire-and-forget dari sisi caller — semua error ditangkap di sini.
 *
 * @param {string} jid
 * @param {string} [reason]
 */
export async function summarizeAndRemember(jid, reason = 'ttl_expired') {
  if (!isRealContactJid(jid)) return; // skip jid sintetis internal

  try {
    const { getHistory } = await import('./chatHistoryService.js');
    const history = getHistory(jid);

    // Tidak ada percakapan berarti → tidak ada yang perlu diringkas
    if (!history || history.length < 2) {
      logger.debug({ jid }, '⏭️ memoryService: history terlalu sedikit, skip summarize');
      return;
    }

    const { askAITool } = await import('./aiService.js');
    const { buildFunctionTool } = await import('../utils/toolCalling.js');

    const conversation = history.slice(-40)
      .map((e) => `${e.role === 'bot' ? 'Bot' : 'User'}: ${e.text}`)
      .join('\n');

    const tool = buildFunctionTool(
      'save_session_memory',
      'Simpan ringkasan sesi dan fakta-fakta penting baru yang ditemukan dari percakapan ini.',
      {
        type: 'object',
        properties: {
          summary: {
            type: 'string',
            description: '1-3 kalimat ringkasan inti percakapan sesi ini — topik utama, mood, hal yang belum selesai.',
          },
          facts: {
            type: 'array',
            description: 'Fakta BARU yang penting untuk diingat jangka panjang (kosongkan array jika tidak ada fakta baru berarti).',
            items: {
              type: 'object',
              properties: {
                fact: { type: 'string', description: 'Kalimat singkat padat, mis. "Sedang skripsi, target sidang November"' },
                category: { type: 'string', enum: ['preference', 'relationship', 'goal', 'sensitive', 'event', 'general'] },
                importance: { type: 'integer', minimum: 1, maximum: 5, description: '1=kecil, 5=sangat penting/sensitif' },
              },
              required: ['fact', 'category', 'importance'],
            },
          },
        },
        required: ['summary', 'facts'],
      }
    );

    const result = await askAITool({
      jid: `memory_summarize_${jid}_${Date.now()}`,
      userText: `Percakapan WhatsApp berikut baru saja berakhir (sesi ditutup). Ekstrak ringkasan dan fakta penting baru dari percakapan ini:\n\n${conversation}`,
      systemPrompt: 'Kamu adalah sistem ekstraksi memori percakapan. Gunakan tool yang tersedia untuk melaporkan hasil. Jangan mengulang fakta yang sudah umum/trivial.',
      tools: [tool],
      forceNew: true,
      useMemory: false,
      model: config.ai.taskModel,
    });

    if (result.name !== 'save_session_memory') {
      logger.warn({ jid }, '⚠️ memoryService: AI tidak melaporkan hasil summarize, skip');
      return;
    }

    await saveSummary(jid, result.args.summary, reason);

    if (Array.isArray(result.args.facts)) {
      for (const f of result.args.facts) {
        await rememberFact(jid, f.fact, f.category, f.importance);
      }
    }

    logger.info({ jid, reason, newFacts: result.args.facts?.length ?? 0 }, '✅ memoryService: sesi berhasil diringkas & disimpan');
  } catch (err) {
    logger.error({ jid, err: err.message }, '❌ memoryService: gagal summarize sesi');
  }
}
