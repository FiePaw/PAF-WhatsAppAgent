# 🤖 WhatsApp AI Bot

Bot WhatsApp berbasis **Baileys** dengan integrasi **OpenAI-Compatible AI API** (Qwen).  
Mendukung sistem plugin, AI Agent mode untuk owner, dan anti-spam delay.

---

## 📁 Struktur Folder

```
wa-bot/
├── index.js                    ← Entry point
├── .env                        ← Konfigurasi environment
├── package.json
│
├── config/
│   └── config.js               ← Konfigurasi bot, persona AI, dll
│
├── core/
│   ├── bot.js                  ← Koneksi Baileys, QR auth, event listener
│   ├── pluginLoader.js         ← Auto-load plugin dari /plugins
│   └── messageHandler.js      ← Router pesan masuk
│
├── plugins/                    ← ⭐ Tambah plugin baru di sini
│   ├── help.js                 ← !help / !menu
│   ├── ai.js                   ← !ai / !ask / !tanya
│   ├── reset.js                ← !reset — reset session AI
│   └── agent.js                ← !status, !sessions, dll (owner only)
│
├── services/
│   ├── aiService.js            ← Wrapper HTTP ke AI API
│   └── sessionStore.js         ← Simpan X-Session-ID per JID
│
├── utils/
│   ├── delay.js                ← Anti-spam: typing delay per karakter
│   ├── logger.js               ← Pino logger
│   └── helpers.js              ← Utilitas umum
│
└── auth/
    └── session/                ← Data auth Baileys (auto-generated saat scan QR)
```

---

## ⚙️ Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Konfigurasi `.env`

```env
OWNER_NUMBER=6281234567890      # Nomor owner tanpa + atau spasi
BOT_PREFIX=!
AI_API_URL=http://108.137.15.61:9000
AI_MODEL=qwen
CHAR_DELAY_MS=40                # Delay per karakter (anti-spam)
MAX_DELAY_MS=4000               # Batas max delay
```

### 3. Jalankan bot

```bash
npm start
```

Scan QR yang muncul di terminal dengan WhatsApp.

---

## 🔌 Cara Membuat Plugin Baru

Buat file baru di folder `plugins/`, contoh `plugins/sticker.js`:

```js
const plugin = {
  name: 'Sticker',
  description: 'Buat sticker dari gambar',
  commands: ['sticker', 'stiker'],   // command yang trigger plugin ini
  ownerOnly: false,                  // true = hanya owner

  handler: async ({ sock, msg, jid, reply, fullArgs }) => {
    // Logic kamu di sini
    await reply('Fitur sticker belum tersedia.');
  },
};

export default plugin;
```

Plugin otomatis di-load saat bot start. **Tidak perlu register manual.**

### Context object yang tersedia di `handler`:

| Property | Tipe | Keterangan |
|----------|------|------------|
| `sock` | object | Baileys socket (untuk sendMessage, dll) |
| `msg` | object | Raw Baileys message |
| `jid` | string | Chat JID (nomor/grup) |
| `sender` | string | Sender JID |
| `isOwner` | boolean | Apakah sender adalah owner |
| `text` | string | Teks lengkap pesan |
| `command` | string | Command yang dipakai (tanpa prefix) |
| `args` | string[] | Argumen dalam array |
| `fullArgs` | string | Semua argumen sebagai string |
| `reply(text)` | function | Kirim reply dengan typing delay |

---

## 🤖 Alur AI Agent

```
Pesan masuk
    │
    ├─ isCommand? ──→ Plugin handler
    │                   ├─ ownerOnly && !isOwner → "🔒 Owner only"
    │                   └─ Execute plugin
    │
    └─ Bukan command ──→ AI Chat
                          ├─ Owner → ownerPersona (agent mode)
                          └─ User  → regularPersona (chat biasa)
```

---

## 🛡️ Anti-Spam

Setiap pesan yang dikirim bot akan:
1. Set presence ke `composing` (typing indicator)
2. Delay selama `length(text) × CHAR_DELAY_MS` ms (max `MAX_DELAY_MS`)
3. Set presence ke `paused`
4. Kirim pesan

Ini mensimulasikan manusia mengetik dan sangat mengurangi risiko deteksi bot/spam oleh WhatsApp.

---

## 📡 Integrasi AI API

Bot menggunakan endpoint `POST /v1/chat/completions` dari server Qwen di `108.137.15.61:9000`.

- **Session per user**: Setiap nomor WA memiliki `X-Session-ID` tersendiri → konteks percakapan terjaga
- **Continue mode**: Session otomatis dipakai untuk pesan berikutnya dari user yang sama
- **Session TTL**: In-memory session di bot expire sesuai `SESSION_TTL` (default 1 jam)
- **Reset session**: User bisa ketik `!reset` untuk mulai percakapan baru

---

## 📝 Commands

| Command | Siapa | Fungsi |
|---------|-------|--------|
| `!help` | Semua | Tampilkan menu |
| `!ai [teks]` | Semua | Tanya AI langsung |
| `!reset` | Semua | Reset session AI |
| `!status` | Owner | Status bot & API |
| `!sessions` | Owner | Lihat session aktif |
| `!clearsessions` | Owner | Hapus semua session |
| `!ping` | Owner | Cek latency AI API |
