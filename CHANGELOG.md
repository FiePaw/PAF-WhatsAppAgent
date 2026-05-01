# Changelog

Semua perubahan penting pada project ini didokumentasikan di file ini.  
Format mengikuti [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

---

## [1.9.0] — 2026-05-01

### Added
- `services/cronService.js` — scheduler tugas berkala berbasis cron tanpa dependensi eksternal. Mendukung cron expression 5-field standar, alias (`@hourly`, `@daily`, `@weekly`, `@monthly`, `@yearly`), dan shorthand interval (`@every_<N>s`). API: `register`, `start`, `stop`, `startAll`, `stopAll`, `unregister`, `list`. Singleton — satu instance dipakai seluruh bot.
- `services/db.js` — database JSON berbasis file. Setiap collection disimpan sebagai `/data/<collection>.json`. API: `insert`, `findOne`, `find`, `update`, `upsert`, `delete`, `clear`, `count`. Write queue per collection mencegah race condition pada operasi concurrent. Auto-assign `_id` (timestamp + random) dan `createdAt`/`updatedAt`.
- `plugins/reminder.js` — plugin contoh yang mengintegrasikan `db` dan `cronService`: set reminder berbasis waktu (`!remind <menit> <pesan>`), list reminder aktif (`!reminders`), hapus reminder (`!remindclear`). Cron job `* * * * *` mengecek reminder jatuh tempo tiap menit dan mengirim pesan otomatis.

### Changed
- `core/pluginLoader.js` — saat load plugin, jika ada field `crons: []` di export default, setiap entry otomatis didaftarkan ke `cronService` (`autoStart: false`). Job baru aktif setelah `connection.open` di `bot.js`.
- `core/bot.js` — tambah `cronService.startAll()` setelah semua inisialisasi selesai di `connection.open`. Tambah `cronService.stopAll()` saat koneksi terputus (`connection.close`) agar job tidak berjalan saat bot offline.

### Architecture
Plugin kini dapat mendeklarasikan cron job langsung di export default via field `crons`:
```js
crons: [{ name: 'plugin:job', expr: '0 9 * * *', handler: async () => { ... } }]
```
`pluginLoader` mendaftarkan, `bot.js` menjalankan — plugin tidak perlu menyentuh `cronService` secara langsung kecuali untuk kontrol dinamis.

---

## [1.8.0] — 2026-05-01

### Added
- `services/aiService.js` — fungsi baru `warmupOwnerSession(ownerJid, systemPrompt)`: mengirim persona owner ke Qwen saat bot start sebagai pesan inisiasi. Session AI owner sudah punya konteks persona **sebelum** pesan pertama masuk — tidak ada cold-start lagi.

### Changed
- `core/bot.js` — setelah `connection.open`, memanggil `getPersona(ownerJid, true)` lalu `warmupOwnerSession()`. Persona owner dikirim ke Qwen satu kali saat connect, bukan saat pesan pertama tiba. Jika warmup gagal (server AI tidak tersedia), fallback ke perilaku lama (persona dikirim bersama pesan pertama).

### Behavior
- Sebelumnya: percakapan pertama owner = cold-start, system prompt + pesan pertama dikirim bersamaan
- Sekarang: saat bot connect → warmup → session owner siap → pesan pertama owner langsung masuk dalam continue mode dengan persona yang sudah aktif

---

## [1.7.0] — 2026-04-27

### Changed
- `core/messageHandler.js` — intent detection dan AI chat untuk owner sekarang berjalan **secara paralel** (`Promise.all`). Sebelumnya sequential: intent dulu → jika null → AI chat. Sekarang keduanya dikirim ke Qwen bersamaan. Jika intent terdeteksi, hasil AI chat dibuang. Jika intent null, hasil AI chat langsung dipakai. Latency efektif = `max(intent, ai_chat)` bukan `intent + ai_chat`.

### Performance
- Response time untuk owner turun signifikan — tidak ada lagi waktu tunggu sequential antara intent detection dan AI chat

---

## [1.6.0] — 2026-04-27

### Added
- `services/intentSessionService.js` — dedicated session store untuk intent detection, terpisah dari chat session. Bot membuat satu sesi Qwen per sender khusus untuk memantau intent. Qwen di sesi ini punya memori percakapan lengkap → deteksi intent lebih akurat untuk kalimat ambigu atau multi-turn. Auto-reinit saat session expired (404). Expose: `initIntentSession`, `initOwnerIntentSession`, `detectIntentWithSession`, `deleteIntentSession`, `listIntentSessions`

### Changed
- `core/bot.js` — panggil `initOwnerIntentSession()` saat `connection.open`, intent session owner siap sebelum pesan pertama masuk
- `core/triggeredPluginHandler.js` — hapus one-shot request per pesan (setiap pesan buat session baru), ganti dengan `detectIntentWithSession()` yang menggunakan session persisten. Qwen kini punya konteks percakapan saat mendeteksi intent
- `plugins/agent.js` — `!sessions` menampilkan chat sessions dan intent sessions secara terpisah; `!status` menampilkan jumlah keduanya

### Architecture
Setiap sender kini memiliki dua session Qwen yang berjalan terpisah:
- **Chat session** (`sessionStore`) — AI chat biasa, konteks percakapan user
- **Intent session** (`intentSessionService`) — memantau semua pesan owner, selalu return JSON intent

---

## [1.5.0] — 2026-04-27

### Added
- `core/triggeredPluginHandler.js` — infrastruktur triggered plugin: load otomatis semua file dari `plugins/triggered/`, kirim teks ke Qwen untuk deteksi intent, routing ke plugin berdasarkan JSON response
- `plugins/triggered/` — folder baru khusus triggered plugin
- `plugins/triggered/sendMessage.js` — triggered plugin pertama: deteksi intent kirim pesan dari teks natural owner (bahasa Indonesia/informal), kirim ke nomor target dengan format pesan, reply konfirmasi ke owner

### Changed
- `core/messageHandler.js` — tambah routing: pesan non-command dari owner → `handleTriggeredPlugin()` → jika tidak ada intent → AI chat
- `config/persona.json` — update persona owner: Aria kini aware sebagai agent yang bisa menjalankan aksi nyata di WhatsApp

---

## [1.4.0] — 2026-04-26

### Added
- `config/persona.json` — konfigurasi persona AI per user: key `owner`, `default`, dan `users[nomor/lid]`
- `services/personaService.js` — load, save, dan hot-reload `persona.json` tanpa restart bot
- `plugins/persona.js` — manage persona via chat: `!persona list/set/del/owner/default` (owner only)

### Changed
- `core/messageHandler.js` — system prompt diambil dari `personaService.getPersona()`, prioritas: user spesifik → owner → default
- `config/config.js` — hapus `regularPersona` dan `ownerPersona`, dipindah ke `persona.json`

---

## [1.3.0] — 2026-04-26

### Fixed
- `services/aiService.js` — system prompt hanya dikirim di pesan pertama (session baru). Continue mode hanya kirim user message + `X-Session-ID`
- `services/aiService.js` — sanitasi newline `\n` di system prompt menjadi spasi — mencegah server Qwen men-trigger submit terpisah per baris
- `config/config.js` — persona ditulis satu baris tanpa newline

---

## [1.2.0] — 2026-04-26

### Added
- Status online (`MARK_ONLINE=true`) — `markOnlineOnConnect` + `sendPresenceUpdate('available')` saat connect
- Auto read receipt (`AUTO_READ=true`) — `sock.readMessages()` setiap pesan masuk → centang biru
- Toggle keduanya via `.env`

---

## [1.1.0] — 2026-04-26

### Fixed
- `utils/helpers.js` — `isOwner()` tidak lagi bandingkan angka LID dengan nomor HP. Cek exact match `@lid` dan `@s.whatsapp.net` secara terpisah — LID adalah ID acak, bukan nomor telepon
- `config/config.js` — tambah `ownerLid` dari `OWNER_LID` di `.env`
- `core/bot.js` — log hint jelas saat `OWNER_LID` belum diisi, serta resolve LID via `onWhatsApp()` sebagai fallback
- `core/bot.js` — Baileys logger fully silent di semua level untuk suppress noise internal (`Timed Out fetchProps`, dll)
- `.env` — tambah field `OWNER_LID`

---

## [1.0.0] — 2026-04-26

### Added
- Koneksi WhatsApp via Baileys dengan QR auth, session disimpan di `auth/session/`
- Auto-reconnect saat koneksi terputus
- Sistem plugin modular — auto-load semua `.js` di `plugins/`, tidak perlu register manual
- `plugins/help.js` — `!help` / `!menu`
- `plugins/ai.js` — `!ai` / `!ask` / `!tanya`
- `plugins/reset.js` — `!reset` untuk hapus session AI
- `plugins/agent.js` — owner-only: `!status`, `!sessions`, `!clearsessions`, `!ping`
- Integrasi AI API OpenAI-Compatible (`POST /v1/chat/completions`) di `108.137.15.61:9000`
- Session per JID dengan `X-Session-ID` (continue mode), in-memory store dengan TTL dan auto-cleanup
- Anti-spam typing delay per karakter (`CHAR_DELAY_MS`, `MAX_DELAY_MS`)
- AI Agent mode: owner dan user biasa mendapat persona berbeda
- Pino logger dengan pretty-print
- Konfigurasi lengkap via `.env`