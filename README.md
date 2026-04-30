# 🤖 WhatsApp AI Bot

Bot WhatsApp berbasis **[Baileys](https://github.com/WhiskeySockets/Baileys)** dengan integrasi **OpenAI-Compatible AI API** (Qwen). Mendukung sistem plugin modular, triggered plugin berbasis intent detection, persona AI per user, AI Agent mode untuk owner, dan anti-spam typing delay.

---

## 📁 Struktur Folder

```
wa-bot/
├── index.js                          ← Entry point
├── .env                              ← Konfigurasi environment (secrets)
├── package.json
├── README.md
├── CHANGELOG.md
├── PLUGIN_SETUP.md
│
├── config/
│   ├── config.js                     ← Konfigurasi utama bot
│   └── persona.json                  ← Persona AI per user / global (hot-reload)
│
├── core/
│   ├── bot.js                        ← Koneksi Baileys, QR auth, reconnect, init sessions
│   ├── pluginLoader.js               ← Auto-load semua command plugin dari /plugins
│   ├── messageHandler.js             ← Router: command → plugin | owner → parallel(intent+AI) | user → AI
│   └── triggeredPluginHandler.js     ← Load triggered plugin, routing berdasarkan intent JSON
│
├── plugins/                          ← ⭐ Command plugin (dipanggil via prefix !)
│   ├── help.js                       ← !help / !menu
│   ├── ai.js                         ← !ai / !ask / !tanya
│   ├── reset.js                      ← !reset — reset chat session AI
│   ├── agent.js                      ← !status, !sessions, !clearsessions, !ping (owner only)
│   ├── persona.js                    ← !persona — manage persona per user (owner only)
│   │
│   └── triggered/                    ← ⚡ Triggered plugin (dipanggil via intent detection)
│       └── sendMessage.js            ← Intent: "sendMessage" — kirim pesan ke nomor lain
│
├── services/
│   ├── aiService.js                  ← HTTP wrapper ke AI API + chat session logic
│   ├── sessionStore.js               ← In-memory store X-Session-ID chat per JID + TTL
│   ├── intentSessionService.js       ← Dedicated session store untuk intent detection per sender
│   └── personaService.js             ← Load/save/hot-reload persona.json
│
├── utils/
│   ├── delay.js                      ← Anti-spam: typing delay per karakter
│   ├── logger.js                     ← Pino logger
│   └── helpers.js                    ← isOwner, parseCommand, jidToNumber, dll
│
└── auth/
    └── session/                      ← Data auth Baileys (auto-generated saat scan QR)
```

---

## ⚙️ Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Konfigurasi `.env`

```env
# Nomor owner (tanpa + atau spasi)
OWNER_NUMBER=628xxxxxxxxxx

# LID owner — isi dari log "sender" saat pertama owner kirim pesan
# Contoh: jika log menampilkan sender: "225545979723871" → isi 225545979723871
OWNER_LID=

# Prefix command
BOT_PREFIX=!

# OpenAI-Compatible API Server
AI_API_URL=http://108.137.15.61:9000
AI_MODEL=qwen

# Status online saat bot connect (true/false)
MARK_ONLINE=true

# Auto baca pesan masuk → centang biru (true/false)
AUTO_READ=true

# Anti-spam: delay per karakter (ms)
CHAR_DELAY_MS=40
MAX_DELAY_MS=4000

# Chat session TTL in-memory (ms), default 1 jam
SESSION_TTL=3600000

# Log level: trace | debug | info | warn | error
LOG_LEVEL=info
```

### 3. Konfigurasi persona di `config/persona.json`

```json
{
  "owner": "Kamu adalah Aria, AI agent pribadi owner. ...",
  "default": "Kamu adalah Aria, asisten WhatsApp yang ramah. ...",
  "users": {
    "628111111111": "Kamu adalah Aria, teman Budi. Panggil dia Budi. ..."
  }
}
```

> ⚠️ Tulis persona dalam **satu baris tanpa newline** — newline menyebabkan server Qwen mengirim prompt terputus-putus.

### 4. Jalankan bot

```bash
npm start
```

Scan QR yang muncul di terminal dengan WhatsApp. Session disimpan otomatis di `auth/session/` — QR hanya perlu scan sekali.

---

## 🤖 Alur Kerja Bot

```
Bot start
    └─ initOwnerIntentSession() → buat intent session owner di Qwen

Pesan masuk (WA)
    │
    ├─ fromMe? → Abaikan
    ├─ Auto read receipt (centang biru) ← jika AUTO_READ=true
    ├─ Deteksi owner (isOwner)
    │
    ├─ isCommand (prefix "!")?
    │     ├─ Plugin tidak ditemukan → "❓ Command tidak dikenal"
    │     ├─ ownerOnly && !isOwner → "🔒 Owner only"
    │     └─ Execute plugin.handler(ctx)
    │
    ├─ isOwner && bukan command?
    │     └─ Promise.all ─┬─ Intent session → Qwen return JSON { intent, params }
    │                     └─ Chat session   → Qwen return respons AI
    │                          │
    │                          ├─ intent != null → jalankan triggered plugin, buang hasil AI → STOP
    │                          └─ intent null    → kirim hasil AI ke owner → STOP
    │
    └─ Non-owner, bukan command → AI Chat biasa
          ├─ getPersona(sender) → ambil persona dari persona.json
          ├─ Session ada? → continue mode (X-Session-ID)
          └─ Session baru? → system prompt + user message (1 baris)
```

---

## ⚡ Triggered Plugin

Triggered plugin aktif **bukan dari command prefix**, melainkan dari **deteksi intent** pada teks natural owner. Hanya berjalan untuk owner.

**Dual session per owner:**

| Session | Store | Tujuan |
|---------|-------|--------|
| Chat session | `sessionStore` | Respons AI percakapan biasa |
| Intent session | `intentSessionService` | Memantau setiap pesan, return JSON intent |

Kedua request ke Qwen dikirim **secara paralel** (`Promise.all`) — tidak ada latency tambahan.

**Intent session dibuat saat bot start** (`initOwnerIntentSession()`) — Qwen sudah siap memantau sebelum pesan pertama masuk. Session bersifat persisten di Qwen sehingga memiliki memori percakapan lengkap untuk deteksi intent yang lebih akurat.

**Triggered plugin yang tersedia:**

| Intent | File | Contoh kalimat natural |
|--------|------|------------------------|
| `sendMessage` | `triggered/sendMessage.js` | "kirimin pesan ke 628xxx bilang besok gua telat" |

**Menambah triggered plugin baru:** lihat [PLUGIN_SETUP.md](./PLUGIN_SETUP.md)

---

## 🎭 Sistem Persona

Persona dikelola di `config/persona.json` dan di-**hot-reload** (perubahan berlaku tanpa restart bot).

**Prioritas lookup:**
1. `users[nomor]` — persona spesifik untuk nomor tersebut
2. `users[lid]` — persona spesifik via LID WhatsApp
3. `owner` — jika sender adalah owner
4. `default` — fallback untuk semua user

**Manage persona via chat (owner only):**

| Command | Fungsi |
|---------|--------|
| `!persona list` | Lihat semua persona |
| `!persona set 628xxx [teks]` | Set persona untuk nomor |
| `!persona del 628xxx` | Hapus persona user |
| `!persona owner [teks]` | Update persona owner |
| `!persona default [teks]` | Update persona default |

---

## 🛡️ Anti-Spam

Setiap pesan yang dikirim bot:
1. Set presence ke `composing` (typing indicator)
2. Delay selama `panjang_teks × CHAR_DELAY_MS` ms (max `MAX_DELAY_MS`)
3. Set presence ke `paused`
4. Kirim pesan

---

## 📡 Integrasi AI API

Bot menggunakan `POST /v1/chat/completions` (OpenAI-compatible) di `108.137.15.61:9000`.

**Chat session:**
- Pesan pertama: system prompt + user message digabung jadi satu `user` message → server buat session → simpan `X-Session-ID`
- Continue mode: kirim user message saja + header `X-Session-ID`
- Session expire (404): auto-retry sebagai pesan pertama
- Reset manual: `!reset`

**Intent session:**
- Dibuat saat bot start dengan system prompt khusus untuk intent detection
- Setiap pesan non-command owner dikirim ke session ini
- Qwen selalu return JSON: `{ "intent": "...", "params": {...} }` atau `{ "intent": null }`
- Auto-reinit jika session expired

---

## 📝 Daftar Commands

| Command | Akses | Fungsi |
|---------|-------|--------|
| `!help` | Semua | Tampilkan menu |
| `!ai [teks]` | Semua | Tanya AI langsung |
| `!reset` | Semua | Reset chat session AI |
| `!status` | Owner | Status bot, AI server, jumlah sessions |
| `!sessions` | Owner | Lihat chat sessions dan intent sessions |
| `!clearsessions` | Owner | Hapus semua chat session |
| `!ping` | Owner | Cek latency AI API |
| `!persona list` | Owner | Lihat semua persona |
| `!persona set` | Owner | Set persona per user |
| `!persona del` | Owner | Hapus persona user |
| `!persona owner` | Owner | Update persona owner |
| `!persona default` | Owner | Update persona default |

---

## 📖 Dokumentasi Lanjutan

- [PLUGIN_SETUP.md](./PLUGIN_SETUP.md) — Panduan lengkap membuat command plugin dan triggered plugin
- [CHANGELOG.md](./CHANGELOG.md) — Riwayat perubahan