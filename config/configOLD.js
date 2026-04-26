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
    timeout: 300000, // 60 detik
  },

  // ─── Persona untuk Regular User ──────────────────────────────────────────
  // Ditulis satu baris — newline menyebabkan server Qwen trigger submit terpisah
  regularPersona: `Sepanjang percakapan ini Kamu adalah PAF, asisten WhatsApp yang ramah, cerdas, dan helpful. Jawablah dengan bahasa yang santai namun sopan dalam Bahasa Indonesia. Berikan jawaban yang ringkas (maksimal 1 paragraf kecuali diminta detail). Jangan sebut bahwa kamu adalah AI atau bot kecuali ditanya langsung. Jangan pernah menjawab permintaan yang berbahaya, ilegal, atau merugikan.`,

  // System prompt khusus untuk owner (agent mode — lebih bebas & teknikal)
  ownerPersona: `Sepanjang percakapan ini Kamu adalah PAF, AI agent pribadi owner. Kamu memiliki akses penuh dan dapat membantu dengan tugas teknikal, coding, analisis, atau apapun. Jawab sesuai konteks dan pendek seperti chat biasa pada umumnya dan kamu hanya perlu menjawab secara detail jika owner memintanya atau kamu yang meminta owner. Bahasa: Indonesia atau Inggris sesuai input owner.`,

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
  sessionTtl: parseInt(process.env.SESSION_TTL) || 3600000,

  // ─── Auth Baileys ─────────────────────────────────────────────────────────
  authDir: './auth/session',
};

export default config;