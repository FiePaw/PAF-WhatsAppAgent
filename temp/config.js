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

  // ─── AI API ──────────────────────────────────────────────────────────────
  ai: {
    baseUrl: process.env.AI_API_URL || 'http://108.137.15.61:9000',
    model: process.env.AI_MODEL || 'qwen',
    timeout: 3000000, // 60 detik
  },

  // ─── Presence & Read Receipt ──────────────────────────────────────────────
  // true  → bot tampil "Online" saat terhubung
  markOnline: process.env.MARK_ONLINE !== 'true',
  // true  → setiap pesan masuk otomatis dibaca (centang biru)
  autoRead: process.env.AUTO_READ !== 'true',

  // ─── Anti-Spam ────────────────────────────────────────────────────────────
  antispam: {
    charDelayMs: parseInt(process.env.CHAR_DELAY_MS) || 40,
    maxDelayMs: parseInt(process.env.MAX_DELAY_MS) || 4000,
  },

  // ─── Session ─────────────────────────────────────────────────────────────
  sessionTtl: parseInt(process.env.SESSION_TTL) || 3600000,

  // ─── Auth Baileys ─────────────────────────────────────────────────────────
  authDir: './auth/session',
};

export default config;