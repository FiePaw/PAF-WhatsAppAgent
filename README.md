# 🤖 WhatsApp AI Bot

Bot WhatsApp berbasis **[Baileys](https://github.com/WhiskeySockets/Baileys)** dengan integrasi **OpenAI-Compatible AI API** (Qwen). Mendukung sistem plugin modular, triggered plugin berbasis intent detection, persona AI per user dan per grup, grup sebagai channel input/output plugin, AI Agent mode untuk owner, database JSON, cron scheduler, dan anti-spam typing delay.

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
│   ├── bot.js                        ← Koneksi Baileys, QR auth, reconnect, init sessions, warmup grup, cron start
│   ├── pluginLoader.js               ← Auto-load command plugin + daftarkan cron job dari plugin
│   ├── messageHandler.js             ← Router: grup/DM | command → plugin | owner → parallel(intent+AI) | user → AI
│   └── triggeredPluginHandler.js     ← Load triggered plugin, routing berdasarkan intent JSON
│
├── plugins/                          ← ⭐ Command plugin (dipanggil via prefix !)
│   ├── help.js                       ← !help / !menu
│   ├── ai.js                         ← !ai / !ask / !tanya
│   ├── reset.js                      ← !reset — reset chat session AI
│   ├── agent.js                      ← !status, !sessions, !clearsessions, !ping (owner only)
│   ├── persona.js                    ← !persona — manage persona per user (owner only)
│   ├── reminder.js                   ← !remind, !reminders, !remindclear — reminder berbasis waktu
│   ├── group.js                      ← !group — manajemen grup: create, delete, register, channel, persona
│   │
│   └── triggered/                    ← ⚡ Triggered plugin (dipanggil via intent detection)
│       └── sendMessage.js            ← Intent: "sendMessage" — kirim pesan ke nomor lain
│
├── services/
│   ├── aiService.js                  ← HTTP wrapper ke AI API + chat session logic + warmup (owner & grup)
│   ├── sessionStore.js               ← In-memory store X-Session-ID chat per JID + TTL
│   ├── intentSessionService.js       ← Dedicated session store untuk intent detection per sender
│   ├── personaService.js             ← Load/save/hot-reload persona.json
│   ├── groupService.js               ← Manajemen grup: channel input/output, persona per grup, cache
│   ├── db.js                         ← Database JSON berbasis file, collection per file di /data/
│   └── cronService.js                ← Cron scheduler: cron expression, alias, interval
│
├── data/                             ← 🗄️ Data JSON (auto-generated, satu file per collection)
│   ├── groups.json                   ← Data grup terdaftar (channel, persona)
│   └── reminders.json                ← Contoh collection dari plugin reminder
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
  "owner": "Kamu adalah PAF, AI agent pribadi owner. ...",
  "default": "Kamu adalah Aria, asisten WhatsApp yang ramah. ...",
  "users": {
    "628111111111": "Kamu adalah Aria, teman Budi. Panggil dia Budi. ..."
  }
}
```

> ⚠️ Tulis persona dalam **satu baris tanpa newline** — newline menyebabkan server Qwen mengirim prompt terputus-putus. Ini berlaku juga untuk persona grup.

### 4. Jalankan bot

```bash
npm start
```

Scan QR yang muncul di terminal dengan WhatsApp. Session disimpan otomatis di `auth/session/` — QR hanya perlu scan sekali.

---

## 🤖 Alur Kerja Bot

```
Bot start
    ├─ loadPlugins()               → load semua command plugin + daftarkan cron job ke cronService
    └─ startBot()

connection.open
    ├─ Resolve owner LID           (onWhatsApp atau dari .env)
    ├─ initOwnerIntentSession()    → buat intent session owner di Qwen
    ├─ warmupOwnerSession()        → kirim persona owner ke Qwen, session AI owner siap
    ├─ warmup group sessions       → tiap grup yang punya persona di-warmup paralel (session key = groupJid)
    └─ cronService.startAll()      → jalankan semua cron job yang terdaftar

Pesan masuk dari GRUP
    │
    ├─ Grup tidak terdaftar?
    │     ├─ Owner ketik !group register → daftarkan grup otomatis (JID + nama dari metadata)
    │     └─ Pesan lain → diabaikan
    │
    └─ Grup terdaftar?
          ├─ Bukan owner → diabaikan
          ├─ isCommand?
          │     ├─ Command dikenal → plugin.handler(ctx + groupChannel)
          │     └─ Command tidak dikenal → diam (tidak reply error)
          └─ Pesan natural owner
                ├─ Ambil persona: getGroupPersona(groupJid) → fallback ke persona owner
                ├─ Session AI key = groupJid (terpisah per grup)
                ├─ Grup punya input channel → intent detection + AI chat paralel
                └─ Grup tanpa input channel → AI chat saja

Pesan masuk dari DM
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
    │                     └─ Chat session   → Qwen return respons AI (persona owner)
    │                          │
    │                          ├─ intent != null → jalankan triggered plugin, buang hasil AI → STOP
    │                          └─ intent null    → kirim hasil AI ke owner → STOP
    │
    └─ Non-owner, bukan command → AI Chat biasa
          ├─ getPersona(sender) → ambil persona dari persona.json
          ├─ Session ada? → continue mode (X-Session-ID)
          └─ Session baru? → system prompt + user message (1 baris)

connection.close
    └─ cronService.stopAll()       → hentikan semua cron job
```

---

## 🏘️ Sistem Grup

Bot mendukung grup WhatsApp sebagai **channel dua arah** — input dan output — untuk plugin tertentu. Setiap grup terdaftar memiliki tiga lapisan konfigurasi independen:

| Lapisan | Keterangan |
|---------|-----------|
| **Channel** | Routing plugin input/output |
| **Persona** | Konteks AI khusus grup (opsional) |
| **Session AI** | Konteks percakapan terpisah per grup (key = groupJid) |

### Role Channel

| Role | Arti |
|------|------|
| `input` | Owner bisa kirim command dan chat AI di grup ini |
| `output` | Plugin bisa kirim notifikasi/output ke grup ini |
| `both` | Keduanya |
| `none` | Hapus assignment channel |

### Persona Grup

Setiap grup dapat memiliki persona AI tersendiri. Saat owner chat di grup tersebut, persona grup dipakai menggantikan persona owner. Jika grup belum punya persona, fallback ke persona owner secara transparan.

Persona grup di-**warmup saat bot start** — Qwen sudah punya konteks persona sebelum pesan pertama masuk di grup tersebut.

### Manage Grup via Chat

| Command | Keterangan |
|---------|-----------|
| `!group create <nama>` | Buat grup baru, owner otomatis dimasukkan |
| `!group delete <groupJid>` | Bot keluar dan hapus grup dari daftar |
| `!group register` | Di dalam grup: daftarkan grup ini otomatis |
| `!group list` | Tampilkan semua grup beserta channel dan persona |
| `!group info` | Di dalam grup: detail grup, channel, persona aktif |
| `!group channel <groupJid> <pluginKey> <role>` | Set channel plugin pada grup |
| `!group persona <teks>` | Di dalam grup: set persona khusus grup ini |
| `!group persona clear` | Di dalam grup: hapus persona grup |

### Contoh Penggunaan Grup sebagai Channel Plugin

```js
// Plugin kirim output ke grup
import { getGroupOutput } from '../services/groupService.js';

const groupJids = getGroupOutput('reminder');
for (const groupJid of groupJids) {
  await sock.sendMessage(groupJid, { text: '⏰ Reminder: Meeting 5 menit lagi!' });
}
```

**Skenario contoh — Grup Keuangan Pribadi:**
1. `!group create Keuangan Pribadi` → bot buat grup, owner masuk otomatis
2. `!group channel <groupJid> finance both` → grup jadi input+output plugin keuangan
3. `!group persona Kamu adalah asisten keuangan pribadi. Catat semua transaksi yang disebutkan owner...` → set persona khusus
4. Owner chat natural di grup: *"tadi beli makan siang 35rb"* → intent detection menangkap → plugin mencatat
5. Plugin kirim laporan mingguan ke grup secara otomatis via cron

---

## ⚡ Triggered Plugin

Triggered plugin aktif **bukan dari command prefix**, melainkan dari **deteksi intent** pada teks natural owner. Hanya berjalan untuk owner — di DM maupun di grup terdaftar yang punya `input` channel.

**Session per owner:**

| Session | Store | Tujuan |
|---------|-------|--------|
| Chat session | `sessionStore` (key = JID chat) | Respons AI percakapan biasa |
| Intent session | `intentSessionService` (key = senderJid) | Memantau setiap pesan, return JSON intent |

> ℹ️ Intent session menggunakan key `senderJid` (bukan groupJid) — satu session intent dipakai untuk semua pesan owner, baik dari DM maupun dari grup mana pun.

Kedua request ke Qwen dikirim **secara paralel** (`Promise.all`) — tidak ada latency tambahan.

**System prompt intent session dibangun otomatis dari plugin:**

Setiap triggered plugin mendefinisikan field `intentDefinition` — deskripsi kapan intent aktif dan params apa yang diekstrak. Saat bot start, `intentSessionService` mengagregasi semua `intentDefinition` dari plugin yang sudah di-load dan menyuntikkannya ke system prompt Qwen. **Menambah triggered plugin baru tidak memerlukan perubahan pada file core apapun.**

**Triggered plugin yang tersedia:**

| Intent | File | Contoh kalimat natural |
|--------|------|------------------------|
| `sendMessage` | `triggered/sendMessage.js` | "kirimin pesan ke 628xxx bilang besok gua telat" |

**Menambah triggered plugin baru:** lihat [PLUGIN_SETUP.md](./PLUGIN_SETUP.md)

---

## 🎭 Sistem Persona

Bot mendukung persona berlapis — per user, global, dan per grup.

**Warmup saat bot start:**
- Persona owner dikirim ke Qwen saat `connection.open` — session AI owner siap sebelum pesan pertama
- Setiap grup yang punya persona di-warmup secara paralel — masing-masing punya session AI sendiri

**Prioritas persona untuk DM:**
1. `users[nomor]` — persona spesifik untuk nomor tersebut
2. `users[lid]` — persona spesifik via LID WhatsApp
3. `owner` — jika sender adalah owner
4. `default` — fallback untuk semua user

**Prioritas persona untuk Grup:**
1. Persona grup (`groups.json[groupJid].persona`) — jika diset
2. Persona owner — fallback jika grup belum punya persona

**Manage persona user via chat (owner only):**

| Command | Fungsi |
|---------|--------|
| `!persona list` | Lihat semua persona |
| `!persona set 628xxx [teks]` | Set persona untuk nomor |
| `!persona del 628xxx` | Hapus persona user |
| `!persona owner [teks]` | Update persona owner |
| `!persona default [teks]` | Update persona default |

**Manage persona grup (owner only, diketik di dalam grup):**

| Command | Fungsi |
|---------|--------|
| `!group persona <teks>` | Set persona grup ini |
| `!group persona clear` | Hapus persona grup (kembali ke persona owner) |
| `!group persona` | Lihat persona grup aktif |

---

## 🗄️ Database JSON

Bot menyediakan database JSON ringan berbasis file di folder `/data/`. Setiap collection disimpan sebagai file terpisah (`/data/<collection>.json`) dan dapat digunakan oleh plugin manapun.

```js
import db from '../services/db.js';

// Tulis (async)
await db.insert('collection', { field: 'value' });
await db.update('collection', { _id: '...' }, { field: 'new' });
await db.upsert('collection', { key: 'x' }, { value: 1 });
await db.delete('collection', { field: 'value' });

// Baca (synchronous)
db.findOne('collection', { field: 'value' });
db.find('collection', { status: 'active' });
db.count('collection', {});
```

Lihat [PLUGIN_SETUP.md](./PLUGIN_SETUP.md) untuk dokumentasi API lengkap.

---

## 📅 Cron Scheduler

Plugin dapat mendeklarasikan cron job langsung di export default via field `crons`. Job didaftarkan otomatis oleh `pluginLoader` dan dijalankan setelah koneksi WhatsApp terbuka.

```js
export default {
  name: 'myPlugin',
  commands: ['cmd'],
  crons: [
    {
      name: 'myPlugin:dailyTask',
      expr: '0 9 * * *',       // setiap hari jam 09:00
      handler: async () => { /* ... */ },
    },
  ],
  handler: async (ctx) => { /* ... */ },
};
```

**Alias yang tersedia:** `@hourly`, `@daily`, `@weekly`, `@monthly`, `@yearly`, `@every_<N>s`

Lihat [PLUGIN_SETUP.md](./PLUGIN_SETUP.md) untuk format ekspresi lengkap dan contoh.

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
- **Warmup saat start** — persona owner dan persona tiap grup di-warmup saat `connection.open`
- Session per JID: DM owner pakai `senderJid`, chat di grup pakai `groupJid` — konteks tidak bercampur
- Pesan pertama (session baru): system prompt + user message digabung → server buat session → simpan `X-Session-ID`
- Continue mode: kirim user message saja + header `X-Session-ID`
- Session expire (404): auto-retry sebagai pesan pertama
- Reset manual: `!reset`

**Intent session:**
- Dibuat saat bot start dengan system prompt yang dibangun otomatis dari `intentDefinition` semua triggered plugin yang di-load
- System prompt terdiri dari `BASE_PROMPT` (peran & format output Qwen) + daftar intent teragregasi dari plugin
- Setiap pesan non-command owner dikirim ke session ini (key = senderJid, satu session untuk semua chat)
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
| `!remind <menit> <pesan>` | Owner | Set reminder setelah N menit |
| `!reminders` | Owner | Lihat semua reminder aktif |
| `!remindclear` | Owner | Hapus semua reminder aktif |
| `!group create <nama>` | Owner | Buat grup baru |
| `!group delete <groupJid>` | Owner | Hapus grup dari daftar |
| `!group register [nama]` | Owner | Daftarkan grup (di dalam grup: otomatis) |
| `!group list` | Owner | Lihat semua grup terdaftar |
| `!group info [groupJid]` | Owner | Detail grup, channel, persona |
| `!group channel <groupJid> <key> <role>` | Owner | Set channel plugin pada grup |
| `!group persona [teks]` | Owner | Set/lihat persona grup (di dalam grup) |
| `!group persona clear` | Owner | Hapus persona grup |

---

## 📖 Dokumentasi Lanjutan

- [PLUGIN_SETUP.md](./PLUGIN_SETUP.md) — Panduan lengkap membuat command plugin, triggered plugin, menggunakan database, cron scheduler, dan group channel system
- [CHANGELOG.md](./CHANGELOG.md) — Riwayat perubahan