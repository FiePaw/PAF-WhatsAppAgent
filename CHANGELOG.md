# Changelog

Semua perubahan penting pada project ini didokumentasikan di file ini.  
Format mengikuti [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

---

## [2.2.0] — 2026-05-04

### Added
- `core/triggeredPluginHandler.js` — export baru `getIntentDefinitions()`: mengumpulkan field `intentDefinition` dari semua triggered plugin yang sudah di-load dan mengembalikannya sebagai array `{ intent, definition }`. Dipanggil oleh `intentSessionService` saat build system prompt.
- `services/intentSessionService.js` — fungsi baru `resetSystemPromptCache()`: memaksa system prompt di-rebuild ulang dari plugin saat intent session berikutnya di-init. Berguna jika ada perubahan plugin tanpa restart penuh.
- `plugins/triggered/*.js` — field baru **`intentDefinition`** (string) pada setiap triggered plugin. Field ini berisi deskripsi intent yang akan di-inject ke system prompt Qwen secara otomatis. Plugin tanpa field ini tetap berjalan tapi intent-nya tidak akan dikenali Qwen (warning di log).

### Changed
- `services/intentSessionService.js` — `INTENT_SYSTEM_PROMPT` yang hardcoded dihapus. Diganti dengan dua komponen: `BASE_PROMPT` (mendefinisikan peran dan format output Qwen — tidak berubah per plugin) dan `_buildSystemPrompt()` yang lazy-import `getIntentDefinitions()` dari `triggeredPluginHandler.js`, lalu menggabungkan `BASE_PROMPT` + daftar intent dari semua plugin. System prompt di-cache setelah pertama kali di-build dan dipakai ulang untuk semua session berikutnya.
- `core/triggeredPluginHandler.js` — saat load plugin, sekarang juga memvalidasi keberadaan `intentDefinition`. Plugin tanpa field ini mendapat warning di log agar developer sadar intent-nya tidak akan masuk ke Qwen.
- `plugins/triggered/sendMessage.js` — ditambah field `intentDefinition` dengan deskripsi lengkap (kapan intent aktif, params yang diekstrak, kondisi khusus). Definisi intent yang sebelumnya hardcoded di `intentSessionService.js` kini pindah ke sini.
- `PLUGIN_SETUP.md` — diperbarui menyeluruh: section "Mendaftarkan Intent ke Qwen" diganti dengan penjelasan sistem baru (base prompt + agregasi otomatis dari plugin), field `intentDefinition` ditambahkan ke struktur file, semua contoh plugin dan template diperbarui, checklist diperbarui (hapus item "edit `INTENT_SYSTEM_PROMPT` manual"), bagian service `intentSessionService` ditambah export `resetSystemPromptCache`.

### Architecture
Sebelumnya: daftar intent hardcoded di satu konstanta `INTENT_SYSTEM_PROMPT` dalam `intentSessionService.js`. Menambah intent baru berarti harus edit dua file: file plugin dan file service core.

Sekarang: setiap triggered plugin mendefinisikan `intentDefinition`-nya sendiri. `triggeredPluginHandler.js` mengagregasi semua definisi via `getIntentDefinitions()`, dan `intentSessionService.js` mengambilnya via lazy import saat build system prompt. **Menambah triggered plugin baru tidak lagi membutuhkan perubahan pada file core apapun.**

```
Bot start → initOwnerIntentSession()
  → _buildSystemPrompt()
      → lazy import getIntentDefinitions() dari triggeredPluginHandler
      → kumpulkan intentDefinition dari semua plugin yang sudah di-load
      → BASE_PROMPT + daftar intent teragregasi
  → kirim ke Qwen → simpan session ID
```

Lazy import digunakan untuk menghindari circular dependency: `triggeredPluginHandler` sudah import `intentSessionService`, sehingga `intentSessionService` tidak boleh import `triggeredPluginHandler` di top-level.

---

## [2.1.0] — 2026-05-02

### Added
- `services/groupService.js` — tambah field `persona` pada schema DB dan cache. Fungsi baru: `setGroupPersona(groupJid, persona)` untuk simpan/hapus persona per grup, `getGroupPersona(groupJid)` untuk ambil dari cache (return `null` jika belum diset), `listGroupsWithPersona()` untuk enumerate semua grup yang punya persona (dipakai warmup saat bot start).
- `plugins/group.js` — tambah sub-command `!group persona`: set persona grup (diketik di dalam grup), hapus persona (`clear`), lihat persona aktif (tanpa args), dan mode DM (`!group persona <groupJid> <teks>`). `resetSession` dipanggil otomatis setiap kali persona diubah agar langsung aktif. `!group list` dan `!group info` kini menampilkan persona aktif tiap grup.

### Changed
- `core/bot.js` — setelah warmup owner session, ambil semua grup yang punya persona via `listGroupsWithPersona()` lalu warmup session AI masing-masing secara paralel (`Promise.allSettled`). Session key pakai `groupJid` agar terpisah dari session DM owner. Gagal warmup di satu grup tidak menghentikan yang lain.
- `core/messageHandler.js` — session key untuk AI chat di grup diubah dari `sender` (JID owner) menjadi `jid` (JID grup). Setiap grup kini punya session AI sendiri, konteks percakapan tidak bercampur antar grup atau dengan DM. Persona grup diambil via `getGroupPersona(jid)`, fallback ke persona owner jika grup belum punya persona.

### Behavior
- Sebelumnya: owner chat di grup mana pun memakai satu session AI yang sama (session DM owner), persona owner selalu dipakai
- Sekarang: setiap grup punya session AI sendiri dengan persona khusus yang bisa dikonfigurasi per grup. Jika grup belum punya persona → fallback ke persona owner secara transparan

### Architecture
Setiap grup terdaftar kini memiliki tiga lapisan konfigurasi yang independen:
- **Channel** — routing plugin input/output
- **Persona** — konteks AI khusus grup
- **Session AI** — konteks percakapan terpisah per grup (key = groupJid)

---

## [2.0.0] — 2026-05-02

### Added
- `services/groupService.js` — service baru untuk manajemen grup WhatsApp sebagai channel dua arah (input/output) per plugin. Fitur: buat grup baru via Baileys (`groupCreate`), bot leave dan hapus dari daftar (`groupLeave`), daftarkan grup existing, assign grup ke plugin key dengan role `input`/`output`/`both`/`none`, in-memory cache channel map yang di-rebuild otomatis setiap ada perubahan. API publik: `createGroup`, `deleteGroup`, `registerGroup`, `setGroupChannel`, `listGroups`, `findGroup`, `getGroupChannel`, `getGroupOutput`, `getGroupInput`. Data disimpan di `data/groups.json`.
- `plugins/group.js` — plugin command owner-only untuk manajemen grup secara interaktif via chat. Sub-commands: `create`, `delete`, `register`, `list`, `info`, `channel`. Fitur khusus: `!group register` yang diketik **di dalam grup** otomatis mendeteksi JID dan nama grup dari metadata (`sock.groupMetadata`) tanpa perlu input manual. `!group info` di dalam grup otomatis menampilkan info grup tersebut.

### Changed
- `core/messageHandler.js` — refactor besar routing pesan untuk mendukung grup sebagai channel:
  - **Grup tidak terdaftar:** semua pesan diabaikan kecuali `!group register` dari owner — command ini diteruskan ke plugin agar owner bisa mendaftarkan grup langsung dari dalam grup tanpa perlu JID manual
  - **Grup terdaftar:** owner bisa melakukan AI chat, command plugin, dan intent detection. Non-owner tetap diabaikan. Command tidak dikenal di grup diam (tidak reply error). Pesan natural owner di grup dengan `input` channel menjalankan intent detection + AI chat paralel; grup tanpa `input` channel hanya AI chat
  - Semua handler di grup menerima tambahan property `groupChannel` di ctx berisi info channel aktif grup tersebut
- `PLUGIN_SETUP.md` — diperbarui menyeluruh: tambah section baru **Group Channel System (Section 5)** mencakup konsep role input/output/both, alur routing pesan di grup, API lengkap `groupService.js`, contoh penggunaan output ke grup, contoh plugin sadar konteks grup, tabel commands `!group`, checklist plugin dengan group output, catatan behavior (diam di grup jika command tidak dikenal, cache otomatis), dan template plugin dengan group output. Semua template diperbarui dengan `groupChannel` di ctx.

### Architecture
Sistem grup bekerja sebagai lapisan channel di atas plugin yang sudah ada:
- Setiap grup terdaftar bisa di-assign ke satu atau lebih plugin key dengan role berbeda
- Plugin yang ingin kirim output ke grup cukup import `getGroupOutput('pluginKey')` dan loop hasilnya
- Plugin yang ingin menerima input dari grup tidak perlu perubahan kode — `messageHandler` otomatis routing ke plugin yang bersangkutan
- Owner mendaftarkan dan mengatur channel via `!group` command; tidak perlu restart bot — cache diperbarui real-time

### Group Channel Flow
```
Grup tidak terdaftar:
  Owner !group register → bot detect JID+nama otomatis → daftarkan → reply konfirmasi
  Pesan lain → diabaikan

Grup terdaftar:
  Non-owner → diabaikan
  Owner command dikenal → plugin.handler(ctx + groupChannel)
  Owner command tidak dikenal → diam
  Owner pesan natural + input channel → intent detection + AI chat paralel
  Owner pesan natural tanpa input channel → AI chat saja
```

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