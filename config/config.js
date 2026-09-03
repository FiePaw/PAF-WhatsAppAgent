// config/config.js
import 'dotenv/config';

const config = {
  // ─── Owner ───────────────────────────────────────────────────────────────
  ownerNumber: process.env.OWNER_NUMBER || '628988329323',

  // JID lengkap owner (@s.whatsapp.net)
  get ownerJid() {
    return `${this.ownerNumber}@s.whatsapp.net`;
  },

  // LID owner — WhatsApp internal ID (bukan nomor HP, format: 123456789@lid)
  // Prioritas: OWNER_LID di .env → resolve otomatis saat connect → null
  // Cara dapat LID: lihat log "sender" pertama kali owner kirim pesan, salin angkanya ke OWNER_LID di .env
  ownerLid: process.env.OWNER_LID ? `${process.env.OWNER_LID}@lid` : null,

  // ─── Bot Identity ─────────────────────────────────────────────────────────
  botName: 'PAF',
  botPrefix: process.env.BOT_PREFIX || '!',

  // ─── AI API (PAF-Model gateway: DeepSeek + Qwen) ──────────────────────────
  // Pembagian tugas:
  //   - chatModel  → dipakai untuk semua chat/interaksi natural dengan user (DeepSeek)
  //   - taskModel  → dipakai untuk intent detection, deskripsi gambar, generate
  //                  gambar/video, web search, dan pesan chat yang mengandung
  //                  gambar (DeepSeek butuh mode vision khusus, Qwen tidak)
  // Nilai HARUS sesuai regex gateway: ^(deepseek|qwen)(?:\(accountX\))?$
  ai: {
    baseUrl: process.env.AI_API_URL || '',
    chatModel: process.env.AI_CHAT_MODEL || 'deepseek',
    taskModel: process.env.AI_TASK_MODEL || 'qwen',
    timeout: 3000000,
  },

  // ─── Presence & Read Receipt ──────────────────────────────────────────────
  // true  → bot tampil "Online" saat terhubung
  markOnline: process.env.MARK_ONLINE !== 'false',
  // true  → setiap pesan masuk otomatis dibaca (centang biru)
  autoRead: process.env.AUTO_READ !== 'false',

  // ─── Anti-Spam ────────────────────────────────────────────────────────────
  antispam: {
    charDelayMs: parseInt(process.env.CHAR_DELAY_MS) || 40,
    maxDelayMs: parseInt(process.env.MAX_DELAY_MS) || 4000,
  },

  // ─── Session ─────────────────────────────────────────────────────────────
  // Sejak migrasi ke PAF-Model gateway terbaru: sesi AI di SERVER tidak lagi
  // punya TTL otomatis (lihat API_USAGE.md §6.2.1) — sesi hidup selamanya di
  // server sampai di-DELETE eksplisit. TTL di bawah ini murni kebijakan sisi
  // BOT: rolling 24 jam sejak pesan terakhir per JID. Saat TTL tercapai,
  // sessionStore._cleanup() akan meringkas percakapan ke memoryService
  // SEBELUM menghapus sesi (lokal + server via DELETE /v1/sessions/{id}) —
  // lihat services/sessionStore.js dan services/memoryService.js.
  sessionTtl: parseInt(process.env.SESSION_TTL) || 86400000, // 24 jam (rolling per-JID)

  // ─── Auth Baileys ─────────────────────────────────────────────────────────
  authDir: './auth/session',
};

export default config;