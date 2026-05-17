# Changelog

Semua perubahan penting pada project ini didokumentasikan di file ini.  
Format mengikuti [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

---

## [3.7.0] — 2026-05-17

### Changed
- `core/messageHandler.js` — tambah ekstraksi `contextInfo` dari quoted message (reply WhatsApp). Saat user/owner membalas pesan bot, teks yang dikutip diambil dari `contextInfo?.quotedMessage` dan dibungkus bersama pesan user menjadi `textWithQuoteContext`:
  ```
  [Reply pada pesan: "<teks yang dikutip>"]
  <pesan user>
  ```
  Format ini diteruskan ke `askAI()` sebagai `intentText` dan dicatat ke `chatHistory` — sehingga Qwen memahami konteks pesan mana yang sedang dibalas, bukan hanya menerima pesan terisolasi.
- `core/messageHandler.js` — `contextInfo` diekstrak dari tiga kemungkinan field message: `extendedTextMessage`, `imageMessage`, dan `videoMessage` — menangani semua skenario reply (teks, gambar, video).
- `core/messageHandler.js` — `recordMessage` untuk owner dan non-owner kini menyimpan `textWithQuoteContext` (bukan `text` mentah) ke `chatHistory`, sehingga riwayat percakapan mencerminkan konteks reply secara akurat.

### Behavior
- Sebelumnya: saat user membalas pesan bot, Qwen hanya menerima teks baru tanpa tahu pesan mana yang dibalas — respons bisa tidak nyambung jika pesan sebelumnya sudah jauh di atas.
- Sekarang: Qwen menerima pesan dengan konteks penuh — tahu bahwa user sedang membalas kalimat spesifik dari bot, sehingga respons lebih relevan dan koheren.

---

## [3.6.0] — 2026-05-17

### Changed
- `services/statusService.js` — `sendMessage` diubah dari pesan biasa menjadi reply status dengan menambahkan `{ quoted: msg }` pada parameter ketiga `sock.sendMessage`. Hasilnya di WhatsApp penerima muncul sebagai **"replied to your status"** lengkap dengan preview status, bukan pesan chat biasa.

### Behavior
- Sebelumnya: bot mengirim pesan teks biasa ke JID sender — masuk sebagai pesan chat normal tanpa referensi ke status yang diposting.
- Sekarang: bot merespons langsung ke status — muncul sebagai reply status di WhatsApp sender, lebih natural dan sesuai konteks.

---

## [3.5.0] — 2026-05-17

### Added
- `services/statusService.js` — service baru untuk memantau dan merespons status WhatsApp (story) dari kontak yang dikenal. Filter utama: hanya JID yang ada di `chatHistory` (via `getAllKnownJids()`) yang diproses — owner maupun user biasa. Tipe status yang didukung: foto, video, teks. Dokumen, sticker, dan tipe lain di-skip.
- `core/bot.js` — routing baru di event `messages.upsert`: jika `jid === 'status@broadcast'` maka `handleStatus(sock, msg)` dipanggil secara fire-and-forget (`continue` — tidak masuk ke `handleMessage`).

### Logic — Media Handling per Tipe Status
- **Foto** → `downloadMediaMessage` → base64 → dikirim ke Qwen sebagai attachment visual
- **Video** → `jpegThumbnail` dari `videoMessage` (preview frame pertama, sudah tersedia di message object tanpa download penuh) → dikirim ke Qwen sebagai attachment JPEG. Jika thumbnail tidak tersedia, lanjut tanpa visual
- **Teks** → caption/teks status langsung dipakai tanpa attachment

### Logic — Alur per Status
```
Status masuk (status@broadcast)
  ↓
isKnownContact(senderJid)? → tidak dikenal: skip
  ↓
detectStatusType() → unknown: skip
  ↓
Download/ekstrak media sesuai tipe
  ↓
getHistory(senderJid) — 20 pesan terakhir sebagai konteks
getPersona(senderJid, isOwner) — persona sesuai JID
  ↓
buildStatusPrompt() → kirim ke Qwen (session terpisah status_${senderJid})
  ↓
Qwen generate pesan natural 1–3 kalimat
  ↓
typingDelay + sendMessage (quoted: msg) → reply status
  ↓
recordMessage: [Status foto/video/teks: "caption"] → chatHistory user
recordMessage: balasan bot → chatHistory bot
```

### Prompt Design
Qwen menerima: tipe status + caption + riwayat 20 pesan terakhir dengan kontak + instruksi tone. Instruksi menekankan pesan yang personal (merujuk riwayat jika relevan), tidak generik, dan tidak terlihat seperti bot (1–3 kalimat).

### Behavior
- Sebelumnya: status WhatsApp dari semua kontak diabaikan (`return` di `messageHandler` untuk `status@broadcast`).
- Sekarang: status dari kontak yang dikenal (pernah ada di `chatHistory`) direspons secara otomatis dengan pesan yang dianalisa Qwen berdasarkan isi status + konteks percakapan + persona JID. Respons dan konteks status tercatat di `chatHistory` untuk keperluan analisa `proactiveService`.

---



### Fixed
- `services/proactiveService.js` — inject konteks hasil analisa sebelumnya selalu diarahkan ke session owner, padahal JID yang dianalisa bisa saja user biasa. Sekarang inject diarahkan ke session JID yang dianalisa itu sendiri (`jid` bukan `ownerJid`). Jika JID yang dianalisa adalah owner, perilaku tidak berubah. `isOwnerJid` dihitung dengan membandingkan `jid === ownerJid` dan diteruskan ke `getPersona()` agar persona yang digunakan tetap sesuai.

### Behavior
- Sebelumnya: semua hasil analisa proactive selalu diinjeksi ke session owner, sehingga sesi chat user biasa tidak pernah mendapat konteks proactive dan session owner menerima konteks yang tidak relevan.
- Sekarang: hasil analisa diinjeksi ke session JID target yang sesuai — user biasa mendapat konteksnya sendiri, owner mendapat konteksnya sendiri.

---

## [3.4.0] — 2026-05-17

### Fixed
- `services/proactiveService.js` — inject konteks hasil analisa sebelumnya selalu diarahkan ke session owner, padahal JID yang dianalisa bisa saja user biasa. Sekarang inject diarahkan ke session JID yang dianalisa itu sendiri (`jid` bukan `ownerJid`). Jika JID yang dianalisa adalah owner, perilaku tidak berubah. `isOwnerJid` dihitung dengan membandingkan `jid === ownerJid` dan diteruskan ke `getPersona()` agar persona yang digunakan tetap sesuai.

### Behavior
- Sebelumnya: semua hasil analisa proactive selalu diinjeksi ke session owner, sehingga sesi chat user biasa tidak pernah mendapat konteks proactive dan session owner menerima konteks yang tidak relevan.
- Sekarang: hasil analisa diinjeksi ke session JID target yang sesuai — user biasa mendapat konteksnya sendiri, owner mendapat konteksnya sendiri.

---

## [3.3.0] — 2026-05-17

### Added
- `services/aiService.js` — fungsi baru `describeImage({ jid, attachments, caption })`: kirim gambar (base64) ke Qwen vision menggunakan session terpisah (`forceNew: true`, jid unik `image_desc_${jid}_${Date.now()}`). Qwen mendeskripsikan isi gambar dalam 2–4 kalimat bahasa Indonesia — objek, suasana, dan konteks keseluruhan. Return `string` deskripsi atau `null` jika gagal. Session yang digunakan tidak disimpan ke `sessionStore` sehingga tidak mencemari session chat user/owner.
- `core/messageHandler.js` — helper baru `recordImageToHistory({ jid, sender, attachments, caption })`: memanggil `describeImage()` lalu menyimpan hasilnya ke `chatHistory` sebagai pesan user dengan format `[Gambar (caption: "...")] <deskripsi>` atau `[Gambar] <deskripsi>` jika tidak ada caption. Berjalan fire-and-forget — tidak memblokir proses chat utama.

### Changed
- `core/messageHandler.js` — import `describeImage` dari `aiService`. Hook `recordImageToHistory` dipasang di dua titik: owner DM (setelah pencatatan teks) dan non-owner DM (setelah pencatatan teks). Gambar yang dikirim user kini memiliki representasi teks di `chatHistory` yang bisa dibaca oleh `proactiveService` saat analisa.

### Behavior
- Sebelumnya: gambar yang dikirim user tidak tersimpan di `chatHistory` — `proactiveService` tidak mengetahui bahwa user pernah mengirim gambar dan tidak bisa menganalisa konteksnya.
- Sekarang: setiap gambar yang masuk dideskripsikan oleh Qwen dan hasilnya disimpan ke `chatHistory`. `proactiveService` bisa membaca konteks gambar dari history teks tanpa perlu mengakses gambar aslinya.

### Architecture
```
Pesan gambar masuk
  ↓
extractImageAttachment() → base64 attachment
  ↓
recordImageToHistory() [fire-and-forget]
  ↓
describeImage() → session terpisah, forceNew
  → Qwen vision mendeskripsikan gambar
  ↓
recordMessage({ role: 'user', text: '[Gambar] <deskripsi>' })
  ↓
chatHistory tersimpan — proactiveService bisa baca konteks
```

---

## [3.2.0] — 2026-05-17

### Changed
- `services/chatHistoryService.js` — struktur database diubah dari dua collection terpisah (`chatHistory` + `chatJids`) menjadi satu collection `chatHistory` dengan satu dokumen per JID. Setiap dokumen berisi metadata JID (`firstSeen`, `lastSeen`, `messageCount`) dan array `messages[]` dalam satu tempat — tidak ada risiko inkonsistensi antar collection.

### Architecture
Struktur dokumen per JID di `data/chatHistory.json`:
```json
{
  "_id": "...",
  "jid": "628xxx@s.whatsapp.net",
  "firstSeen": "ISO string",
  "lastSeen":  "ISO string",
  "messageCount": 47,
  "messages": [
    { "role": "user", "text": "...", "sender": "...", "timestamp": "ISO string" },
    { "role": "bot",  "text": "...", "sender": "bot", "timestamp": "ISO string" }
  ]
}
```

- `messageCount` mencatat total pesan sepanjang masa (tidak di-reset saat prune) — memberi gambaran historis seberapa aktif kontak.
- `messages[]` hanya berisi pesan 2 hari terakhir — dipangkas otomatis saat `recordMessage` dan `pruneAllOldMessages`.
- Dokumen JID tidak pernah dihapus meski `messages[]` kosong — berfungsi sebagai catatan permanen untuk `getAllKnownJids()`.
- Setiap operasi baca/tulis hanya menyentuh satu dokumen (query by `jid`) — lebih efisien dari scan seluruh collection.

### Behavior
- Sebelumnya: dua collection terpisah (`chatHistory` untuk pesan, `chatJids` untuk registry JID) yang harus selalu disinkronkan secara manual dan bisa tidak konsisten.
- Sekarang: satu dokumen per JID, semua data dalam satu tempat, tidak ada risiko tidak sinkron.

---

## [3.1.0] — 2026-05-17

### Changed
- `services/chatHistoryService.js` — hapus `_knownJids` Set in-memory yang digunakan untuk mendeteksi JID baru. Diganti dengan pengecekan langsung ke database via `isKnownJid(jid)` setiap kali `recordMessage` dipanggil. `registerJid()` melakukan upsert: insert jika JID baru (return `true`), update `lastSeen` dan `messageCount` jika sudah ada (return `false`). Sinyal `true` memicu `onNewJid()` untuk subscribe presence.
- `core/bot.js` — `initProactiveService` kini dipanggil dengan hasil `getAllKnownJids()` (seluruh JID yang pernah ada di registry) alih-alih `getActiveJids()` (hanya JID aktif 2 hari terakhir). Memastikan semua kontak yang pernah dikenal langsung di-subscribe presence-nya saat bot restart, tanpa bergantung pada retention window chatHistory.

### Behavior
- Sebelumnya: `_knownJids` Set in-memory reset setiap bot restart — semua JID dianggap "baru" lagi dan subscribe presence ulang. Data yang hilang hanya efek samping yang tidak berbahaya, namun secara arsitektur tidak konsisten karena state ada di dua tempat (memory + DB).
- Sekarang: deteksi JID baru sepenuhnya berbasis database — tidak ada state in-memory. Bot restart tidak mengubah apapun karena pengetahuan tentang JID yang sudah dikenal tersimpan permanen di DB.

---

## [3.0.0] — 2026-05-17

### Added
- `services/chatHistoryService.js` — service baru untuk mencatat semua pesan natural (bukan command) per JID ke database. Fungsi utama: `recordMessage({ jid, role, text, sender })`, `getHistory(jid)`, `getActiveJids()`, `getAllKnownJids()`, `getJidSummary(jid)`, `pruneAllOldMessages()`. Retention otomatis 2 hari — pesan lebih lama dibuang saat insert dan saat siklus proactive. Dokumen JID tidak dihapus meski messages kosong.
- `services/presenceService.js` — service baru untuk melacak status online/offline setiap JID via Baileys presence API. Fungsi: `subscribePresence(jid)`, `subscribeAll(activeJids)`, `updatePresence(id, presences)`, `getPresence(jid)`. Presence dianggap stale jika tidak ada update lebih dari 10 menit (`STALE_THRESHOLD_MS`). Return `{ isOnline, lastKnownPresence, lastSeen, isStale }`.
- `services/proactiveService.js` — service baru yang berjalan setiap 1 jam via cron `@hourly`. Setiap siklus: cleanup history lama → subscribe presence semua JID aktif → per JID cek jadwal analisa (`isAnalysisAllowed`) → kirim history + status presence ke Qwen → Qwen return JSON keputusan → kirim pesan jika memenuhi syarat → inject konteks ke session JID target → simpan `nextAnalyzeAt`.
- `core/bot.js` — listener baru `sock.ev.on('presence.update', ...)` untuk memperbarui status presence setiap JID secara real-time.

### Changed
- `core/messageHandler.js` — tambah import `recordMessage` dari `chatHistoryService`. Hook pencatatan pesan user dipasang di owner DM dan non-owner DM (hanya pesan teks, sebelum proses AI). Hook pencatatan balasan bot dipasang setelah AI reply berhasil dikirim di kedua jalur tersebut.
- `core/bot.js` — saat `connection.open`: jalankan `pruneAllOldMessages()`, ambil `getAllKnownJids()`, panggil `initProactiveService(knownJids)` untuk subscribe presence dan daftarkan cron job.

### Architecture — Skema Keputusan Qwen (proactiveService)
```
┌──────────────┬──────────────────┬────────────────────────────────────────────┐
│  isOnline    │  shouldSend      │  Tindakan                                  │
├──────────────┼──────────────────┼────────────────────────────────────────────┤
│  true        │  true            │  Kirim pesan inisiatif                     │
│  true        │  false           │  Skip, simpan nextAnalyzeAt                │
│  false       │  true + urgent   │  Kirim pesan (topik penting)               │
│  false       │  true (biasa)    │  Skip, simpan nextAnalyzeAt                │
│  false       │  false           │  Skip, simpan nextAnalyzeAt                │
│  stale/unkn  │  true + urgent   │  Kirim pesan (perlakukan seperti offline)  │
│  stale/unkn  │  true (biasa)    │  Skip                                      │
└──────────────┴──────────────────┴────────────────────────────────────────────┘
```

### Architecture — JSON Response Qwen
```json
{
  "shouldSend":     true | false,
  "isUrgent":       true | false,
  "message":        "pesan yang akan dikirim (string kosong jika shouldSend false)",
  "reason":         "alasan singkat keputusan",
  "nextAnalyzeIn":  "30m" | "1h" | "2h" | "3h" | "6h" | "12h" | "24h" | null,
  "contextSummary": "ringkasan 1-2 kalimat konteks percakapan"
}
```

`nextAnalyzeIn` menentukan kapan JID ini boleh dianalisa lagi oleh cron berikutnya. `null` = ikut jadwal default 1 jam. Cron `@hourly` tetap berjalan setiap jam — `isAnalysisAllowed()` yang menjadi penjaga gerbang per JID.

### Behavior
- Sebelumnya: bot hanya bersifat reaktif — hanya merespons pesan yang masuk.
- Sekarang: bot bersifat proaktif — setiap jam Qwen menganalisa history percakapan semua JID aktif dan memutuskan apakah perlu mengirim pesan inisiatif, membuka topik baru, atau mengingatkan sesuatu. Keputusan mempertimbangkan status online/offline user, urgency topik, dan jadwal analisa yang Qwen tentukan sendiri.

---



### Changed
- `core/messageHandler.js` — alur paralel owner DM dan grup diubah dari `Promise.all` (tunggu keduanya) menjadi `Promise.race` berbasis flag. AI chat diprioritaskan: begitu `askAI` selesai, reply langsung dikirim tanpa menunggu intent detection. Intent detection tetap berjalan di background hingga selesai untuk keperluan side-effect (inject hasil ke chat session di `triggeredPluginHandler`).

### Behavior
- Sebelumnya: `Promise.all([intentPromise, aiPromise])` — bot menunggu **kedua** proses selesai sebelum mengirim reply apapun. Jika intent detection lambat, AI reply yang sudah siap ikut tertahan.
- Sekarang: keduanya tetap berjalan paralel, tapi AI reply dikirim segera begitu selesai. Intent detection yang masih berjalan tidak memblokir pengiriman reply.

### Architecture
Tiga skenario yang di-handle oleh flag `aiReplySent`:

```
Skenario 1 — AI selesai duluan, intent belum:
  aiPromise resolve → cek intentPromise: belum settled
  → kirim AI reply sekarang
  → intentPromise tetap jalan di background (inject ke chat session)

Skenario 2 — Intent selesai duluan, terdeteksi:
  intentPromise resolve(true) → set aiReplySent = true
  → plugin handler sudah kirim reply-nya sendiri
  → AI reply yang menyusul diabaikan (aiReplySent sudah true)

Skenario 3 — Intent selesai duluan, null (tidak ada intent):
  intentPromise resolve(false) → tidak ada yang reply
  → tunggu aiPromise, kirim saat selesai
```

Flag `aiReplySent` mencegah double-reply jika kedua promise selesai hampir bersamaan. Intent promise selalu di-await sampai selesai (`.catch(() => {})`) meski reply sudah dikirim, agar side-effect inject ke chat session tetap terjadi.

Perubahan ini berlaku untuk dua blok paralel: **owner DM** (`if (owner)`) dan **owner di grup terdaftar**.

---

## [2.9.0] — 2026-05-15

### Changed
- `core/messageHandler.js` — alur paralel owner DM dan grup diubah dari `Promise.all` (tunggu keduanya) menjadi `Promise.race` berbasis flag. AI chat diprioritaskan: begitu `askAI` selesai, reply langsung dikirim tanpa menunggu intent detection. Intent detection tetap berjalan di background hingga selesai untuk keperluan side-effect (inject hasil ke chat session di `triggeredPluginHandler`).

### Behavior
- Sebelumnya: `Promise.all([intentPromise, aiPromise])` — bot menunggu **kedua** proses selesai sebelum mengirim reply apapun. Jika intent detection lambat, AI reply yang sudah siap ikut tertahan.
- Sekarang: keduanya tetap berjalan paralel, tapi AI reply dikirim segera begitu selesai. Intent detection yang masih berjalan tidak memblokir pengiriman reply.

### Architecture
Tiga skenario yang di-handle oleh flag `aiReplySent`:

```
Skenario 1 — AI selesai duluan, intent belum:
  aiPromise resolve → cek intentPromise: belum settled
  → kirim AI reply sekarang
  → intentPromise tetap jalan di background (inject ke chat session)

Skenario 2 — Intent selesai duluan, terdeteksi:
  intentPromise resolve(true) → set aiReplySent = true
  → plugin handler sudah kirim reply-nya sendiri
  → AI reply yang menyusul diabaikan (aiReplySent sudah true)

Skenario 3 — Intent selesai duluan, null (tidak ada intent):
  intentPromise resolve(false) → tidak ada yang reply
  → tunggu aiPromise, kirim saat selesai
```

Flag `aiReplySent` mencegah double-reply jika kedua promise selesai hampir bersamaan. Intent promise selalu di-await sampai selesai (`.catch(() => {})`) meski reply sudah dikirim, agar side-effect inject ke chat session tetap terjadi.

Perubahan ini berlaku untuk dua blok paralel: **owner DM** (`if (owner)`) dan **owner di grup terdaftar**.

---

## [2.8.0] — 2026-05-15

### Added
- `config/persona.json` — field `model` opsional di setiap entry persona. Setiap persona kini bisa menentukan akun Qwen spesifik yang dipakai untuk sesi AI-nya. Jika tidak diset, fallback ke `AI_MODEL` di `.env` (default: `qwen`).
- `config/persona.json` — entry baru `"intentSession"`: object khusus yang menyimpan konfigurasi untuk intent detection session. Saat ini hanya mendukung field `model` — system prompt intent session tetap dibangun otomatis dari triggered plugins, bukan dari sini.
- `services/personaService.js` — fungsi baru `getIntentSessionModel()`: membaca `personaData.intentSession.model` dan return string nama akun, atau `null` jika tidak diset. Digunakan oleh `intentSessionService` saat membangun request ke Qwen.
- `services/personaService.js` — fungsi baru `getPersonaPrompt(senderJid, owner)`: helper backward-compat yang return hanya string prompt (tanpa `model`). Berguna untuk kode yang masih mengexpect string dari `getPersona`.

### Changed
- `config/persona.json` — format entry persona diubah dari string menjadi object `{ "prompt": "...", "model": "..." }`. Format lama (string) tetap kompatibel — `personaService` menormalisasi keduanya secara otomatis. Entry `"owner"` kini menggunakan `"model": "account1"`. Entry `"intentSession"` menggunakan `"model": "account2"`. Entry `"default"` dan `"users"` tidak memiliki `model` (fallback ke default).
- `services/personaService.js` — `getPersona(senderJid, owner)` sekarang return object `{ prompt: string, model: string|null }` (sebelumnya: string). Semua caller di `messageHandler.js` dan `bot.js` sudah diperbarui untuk destructure return value ini. `setPersona()` dan `setGlobalPersona()` menerima parameter `model` opsional — jika tidak diisi, model lama dipertahankan.
- `services/personaService.js` — `listPersonas()` kini menampilkan model di setiap entry dalam format `[accountX] prompt...`.
- `services/aiService.js` — `askAI()` menerima parameter baru `model` (opsional). Jika diisi, nilai ini override `config.ai.model` di request body. Jika `null`/`undefined`, tetap pakai model dari config.
- `services/aiService.js` — `warmupOwnerSession(ownerJid, systemPrompt, model)` menerima parameter ketiga `model` opsional. Model diteruskan ke `sendRequest()` saat warmup sehingga session owner langsung terikat ke akun yang benar sejak inisialisasi.
- `services/aiService.js` — `sendRequest()` menerima parameter `model` opsional. Logika pemilihan model: `model param || config.ai.model`.
- `services/Intentsessionservice.js` — import `getIntentSessionModel` dari `personaService`. Semua request ke Qwen di `initIntentSession()` dan `_sendToIntentSession()` kini menggunakan `intentModel = getIntentSessionModel() || config.ai.model` sebagai nilai `model` di request body.
- `core/messageHandler.js` — semua pemanggilan `getPersona()` kini destructure `{ prompt: systemPrompt, model }`. Parameter `model` diteruskan ke `askAI()` di semua alur: owner DM, grup terdaftar, dan non-owner.
- `core/bot.js` — warmup session owner kini destructure `{ prompt: ownerPrompt, model: ownerModel }` dari `getPersona()` dan meneruskan `ownerModel` ke `warmupOwnerSession()`. Warmup grup tetap pass `null` sebagai model (grup tidak memiliki model khusus).

### Behavior
- Sebelumnya: semua percakapan AI (owner, user biasa, grup, intent session) menggunakan akun yang sama dari `AI_MODEL` di `.env`.
- Sekarang: setiap persona bisa dikonfigurasi untuk menggunakan akun Qwen yang berbeda secara independen. Owner chat pakai `account1`, intent detection pakai `account2`, user lain pakai akun default. Konfigurasi dilakukan di `persona.json` tanpa restart bot (hot-reload aktif). Untuk menambah model ke user tertentu cukup tambah field `"model"` di entry user yang bersangkutan.

### Architecture
```
persona.json
  "owner":        { prompt, model: "account1" }  → owner chat  → account1
  "default":      { prompt }                      → user biasa  → AI_MODEL (.env)
  "intentSession":{ model: "account2" }           → intent det. → account2
  "users": {
    "628xxx":     { prompt, model?: "accountX" }  → user spesifik → accountX atau AI_MODEL
  }

getPersona(jid, isOwner)
  → { prompt: string, model: string|null }
  → model null = fallback ke config.ai.model

messageHandler:
  const { prompt: systemPrompt, model } = getPersona(sender, owner)
  askAI({ ..., model })  ← model diteruskan ke request body

intentSessionService:
  const intentModel = getIntentSessionModel() || config.ai.model
  POST /v1/chat/completions { model: intentModel, ... }
```

---

## [2.7.0] — 2026-05-15

### Added
- `services/aiService.js` — fungsi baru `generateImage({ jid, prompt, accountModel })`: kirim request ke Qwen dengan `task_type: "create_image"`. Return `{ text, urls[] }` — URL gambar ada di array `urls`, bukan di `choices[0].message.content`. Timeout diset 180 detik sesuai dokumentasi API.
- `services/aiService.js` — fungsi baru `generateVideo({ jid, prompt, accountModel })`: kirim request ke Qwen dengan `task_type: "create_video"`. Return `{ text, urls[] }`. Timeout 300 detik.
- `services/aiService.js` — fungsi baru `webSearch({ jid, query, accountModel })`: kirim request ke Qwen dengan `task_type: "web_search"`. Return string teks hasil pencarian. Output field `urls` selalu `[]` untuk task ini. Timeout 120 detik.
- `services/aiService.js` — fungsi baru `listModels()`: fetch `GET /v1/models` dari server dan return array nama akun yang aktif (misal `['account1', 'account2', 'account6']`). Listing dinamis — mencerminkan cookie aktif di worker saat dipanggil.
- `services/aiService.js` — konstanta `TASK_TIMEOUTS`: map task type ke nilai timeout masing-masing (`chat: 120_000`, `web_search: 120_000`, `create_image: 180_000`, `create_video: 300_000`). Menggantikan satu nilai `timeout` hardcoded di `axios.create()`.

### Changed
- `services/aiService.js` — `sendRequest()` menerima parameter baru `taskType` (opsional, default `"chat"`). Jika `taskType` bukan `"chat"`, request dianggap sebagai special task: tidak menggunakan `X-Session-ID` (selalu session baru), field `task_type` disertakan di request body, dan session ID dari response tidak disimpan ke `sessionStore`. Return value diubah dari `string` menjadi `{ text, urls }`.
- `services/aiService.js` — `askAI()` kini eksplisit pass `taskType: 'chat'` ke `sendRequest()` dan mengekstrak hanya `.text` dari return value. Signature eksternal tidak berubah — caller yang sudah ada tidak perlu dimodifikasi.
- `services/aiService.js` — timeout tidak lagi di-set di `axios.create()`. Setiap request kini menggunakan timeout dari `TASK_TIMEOUTS[taskType]` yang dipass saat pemanggilan `client.post()`.
- `services/Intentsessionservice.js` — timeout axios dikoreksi dari `3000000` (~50 menit) menjadi `120_000` (120 detik) sesuai rekomendasi dokumentasi API untuk task `chat` dan `web_search`.
- `plugins/scheduled/economicNews.js` — import diganti dari `askAI` ke `webSearch`. Pengambilan berita kini menggunakan `task_type: "web_search"` agar Qwen melakukan pencarian web real-time, bukan menjawab dari knowledge cutoff. Parameter `thinkMode: 'thinking'` dihapus karena `webSearch` tidak mendukung kombinasi `task_type` + `think_mode`.

### Behavior
- Sebelumnya: `aiService` hanya mendukung satu jenis interaksi (chat teks). Semua request menggunakan timeout tunggal 3000000ms yang tidak konsisten. `economicNews` menggunakan `askAI` dengan `thinkMode: 'thinking'` yang menghasilkan berita dari knowledge model (bukan real-time).
- Sekarang: `aiService` mendukung empat task type — `chat`, `web_search`, `create_image`, `create_video`. Timeout disesuaikan per task. `economicNews` menggunakan `webSearch` sehingga berita yang dihasilkan berdasarkan hasil pencarian web terkini. `generateImage` dan `generateVideo` tersedia sebagai fungsi siap pakai untuk triggered/scheduled plugin yang ingin memanfaatkan kemampuan generasi media Qwen.

### Architecture
```
aiService exports:
  askAI()          → task_type: chat       → { text }      → timeout 120s
  webSearch()      → task_type: web_search → { text }      → timeout 120s
  generateImage()  → task_type: create_image → { urls[] }  → timeout 180s
  generateVideo()  → task_type: create_video → { urls[] }  → timeout 300s
  listModels()     → GET /v1/models        → string[]      → timeout 10s
  warmupOwnerSession() / resetSession() / checkHealth() — tidak berubah

Task types khusus (non-chat):
  - Tidak pakai X-Session-ID (selalu session baru)
  - Tidak simpan session ke sessionStore
  - URL media ada di response.urls, bukan choices[0].message.content
```

---

## [2.6.0] — 2026-05-09

### Added
- `core/messageHandler.js` — fungsi baru `extractImageAttachment(sock, msg)`: mendeteksi `imageMessage` dari pesan Baileys, download buffer via `downloadMediaMessage`, convert ke base64, dan return array attachment `[{ filename, data, mime_type }]` siap dikirim ke `askAI`. Return `null` jika pesan bukan gambar atau gagal download.
- `services/aiService.js` — dua parameter opsional baru di `sendRequest()` dan `askAI()`:
  - `thinkMode` — string `"auto"` | `"thinking"` | `"fast"`. Jika diisi, dikirim ke server sebagai `think_mode`. Tidak diisi = server pakai default `"fast"`.
  - `attachments` — array `[{ filename, data (base64), mime_type? }]`. Jika diisi, dikirim ke server bersama request untuk analisis gambar oleh Qwen.
- `services/intentSessionService.js` — `detectIntentWithSession()` dan `_sendToIntentSession()` kini menerima parameter `attachments` opsional. Gambar diteruskan ke Qwen saat intent detection sehingga Qwen bisa menganalisis isi gambar untuk menentukan intent.

### Changed
- `core/messageHandler.js` — beberapa perubahan:
  - Tambah import `downloadMediaMessage` dari `@whiskeysockets/baileys`
  - Guard pesan diubah: dari `if (!text.trim()) return` menjadi `if (!text.trim() && !hasImage) return` — gambar tanpa caption kini tetap diproses
  - `intentText` diperkenalkan: jika ada caption dipakai sebagai teks, jika gambar tanpa caption pakai placeholder `"[gambar dikirim]"` agar intent session tetap punya konteks
  - `attachments` diekstrak di awal dan diteruskan ke semua alur: owner DM (intent detection + AI chat), grup terdaftar (intent detection + AI chat), dan non-owner (AI chat saja)
  - `ctx.attachments` kini tersedia di semua plugin handler (command, triggered)
- `core/triggeredPluginHandler.js` — `handleTriggeredPlugin` kini mengekstrak `attachments` dari `ctx` dan meneruskannya ke `detectIntentWithSession()` dan `plugin.handler()`
- `services/intentSessionService.js` — semua request ke Qwen (init session dan `_sendToIntentSession`) kini eksplisit set `think_mode: 'fast'` — intent detection tidak membutuhkan deep reasoning, ini mengurangi latency secara signifikan

### Behavior
- Sebelumnya: bot hanya memproses pesan teks. Gambar diabaikan kecuali jika ada caption yang dianggap sebagai teks biasa. `askAI` tidak mendukung parameter `thinkMode` atau `attachments`.
- Sekarang: semua user (owner dan non-owner) bisa mengirim gambar ke bot. Gambar diproses bersama teks/caption dan dikirim ke Qwen untuk analisis. Owner yang mengirim gambar juga memicu intent detection — Qwen bisa mendeteksi intent dari isi gambar (misal: foto struk → intent `recordExpense`). `askAI` mendukung `thinkMode` dan `attachments` sebagai parameter opsional.

### Architecture
```
Pesan masuk (teks atau gambar)
  hasImage?
    → extractImageAttachment() → base64 → attachments array
  intentText = caption || "[gambar dikirim]" (jika gambar tanpa caption)

  Owner DM:
    parallel(
      detectIntentWithSession(sender, intentText, attachments),  ← Qwen lihat gambar
      askAI({ jid: sender, userText: intentText, attachments }) ← Qwen lihat gambar
    )

  Grup terdaftar (owner):
    parallel(
      handleTriggeredPlugin({ ...ctx, attachments }),
      askAI({ jid, userText: intentText, attachments })
    )

  Non-owner:
    askAI({ jid: sender, userText: intentText, attachments })

Intent session:
  _sendToIntentSession() → body.think_mode = 'fast' (eksplisit)
  body.attachments = attachments (jika ada)
```

---

## [2.5.0] — 2026-05-08

### Added
- `core/scheduledPluginLoader.js` — loader baru khusus scheduled plugin. Membaca semua file `.js` dari `/plugins/scheduled/`, memvalidasi struktur (`name`, `description`, `crons[]`), dan mendaftarkan setiap cron job ke `cronService` (`autoStart: false`). Job dijalankan oleh `cronService.startAll()` di `bot.js` setelah `connection.open`. Plugin tanpa field wajib atau `crons` kosong diberi warning dan dilewati.
- `plugins/scheduled/` — folder baru khusus scheduled plugin. Plugin di folder ini berjalan otomatis berdasarkan jadwal tanpa command handler — tidak bisa dipanggil manual.
- `plugins/scheduled/economicNews.js` — contoh scheduled plugin pertama: generate ringkasan berita ekonomi global dan Indonesia dari Qwen setiap 4 jam (`@every_4h`), kirim ke grup tertaut (`getGroupOutput('economicNews')`) atau fallback ke DM owner jika tidak ada grup. Menggunakan `jid: 'scheduled:economicNews'` sebagai key session AI yang terisolasi.

### Changed
- `core/bot.js` — tambah `import { loadScheduledPlugins }` dan panggil `await loadScheduledPlugins()` setelah `loadPlugins()` saat startup. Tambah `global._sock = sock` saat `connection.open` untuk expose Baileys socket ke scheduled plugin. Tambah `global._sock = null` saat `connection.close` agar plugin tidak mencoba kirim saat bot offline.
- `services/cronService.js` — perluas `parseExpression()` dengan dua shorthand baru: `@every_<N>m` (interval dalam menit) dan `@every_<N>h` (interval dalam jam). Sebelumnya hanya mendukung `@every_<N>s`. Komentar header diperbarui.
- `PLUGIN_SETUP.md` — diperbarui menyeluruh: header dan tabel jenis plugin diperbarui (dua → tiga jenis), struktur folder ditambah `/plugins/scheduled/`, section baru **3️⃣ Scheduled Plugin** ditambahkan mencakup cara kerja, struktur file, tabel alias cron expression, cara akses `global._sock`, cara pakai `aiService` dari scheduled plugin, contoh plugin news ekonomi lengkap, cara tautkan ke grup, checklist, dan template siap pakai. Ringkasan Cepat ditambah dua blok baru: "Mau buat scheduled plugin" dan "Mau tautkan scheduled plugin ke grup".

### Architecture
Tiga tipe plugin kini tersedia dengan loader dan lifecycle masing-masing:

```
Bot start:
  loadPlugins()          → load /plugins/*.js          → register command handlers
  loadScheduledPlugins() → load /plugins/scheduled/*.js → register cron jobs
  loadTriggeredPlugins() → load /plugins/triggered/*.js → register intent handlers

connection.open:
  global._sock = sock    → scheduled plugin bisa kirim pesan
  cronService.startAll() → semua cron job (command + scheduled) mulai berjalan

connection.close:
  global._sock = null    → guard agar plugin tidak kirim saat offline
  cronService.stopAll()  → semua cron job berhenti
```

| Tipe | Loader | Trigger | Akses sock |
|---|---|---|---|
| Command | `pluginLoader.js` | User ketik `!cmd` | Via `ctx.sock` |
| Triggered | `triggeredPluginHandler.js` | AI deteksi intent | Via `ctx.sock` |
| Scheduled | `scheduledPluginLoader.js` | Cron scheduler | Via `global._sock` |

---

## [2.4.0] — 2026-05-07

### Added
- `core/triggeredPluginHandler.js` — mekanisme **intercept reply plugin**: fungsi `reply` di-wrap menjadi `interceptedReply` sebelum diteruskan ke plugin handler. Teks yang dikirim plugin ke WhatsApp juga ditangkap ke `capturedReply`. Setelah handler selesai, jika ada `capturedReply`, dikirim ke chat session via `askAI()` sebagai konteks sistem dengan format `[SYSTEM] Aksi intent "<intent>" telah dieksekusi. Hasilnya: <teks reply plugin>` — fire & forget, tidak di-await. Jika plugin tidak memanggil `reply`, inject tidak dilakukan.

### Changed
- `core/triggeredPluginHandler.js` — urutan eksekusi diubah: plugin handler dijalankan dulu → reply di-intercept → hasil di-inject ke chat session. Sebelumnya inject dilakukan sebelum plugin handler jalan dengan raw JSON intent sebagai payload.
- `services/groupService.js` — import `getTriggeredPluginByKey` dari `triggeredPluginHandler.js` dipindah dari top-level ke **lazy import** di dalam fungsi `setGroupChannel()`. Ini menyelesaikan circular dependency yang menyebabkan bot stuck saat startup ketika triggered plugin mengimport `groupService`.

### Fixed
- Bot stuck setelah `npm start` saat triggered plugin mengimport `groupService.js` — disebabkan circular dependency: `groupService` → `triggeredPluginHandler` (top-level import) → load triggered plugins → plugin import `groupService` → deadlock. Diperbaiki dengan lazy import `getTriggeredPluginByKey` di dalam `setGroupChannel()`.

### Behavior
- Sebelumnya: chat session menerima raw JSON `{"intent":"...","params":{...}}` sebelum plugin handler jalan — chat session hanya tahu intent dan params, tidak tahu hasil eksekusi sebenarnya.
- Sekarang: chat session menerima teks reply nyata dari plugin setelah handler selesai — chat session tahu persis apa yang sudah dilakukan bot dan hasilnya, sehingga percakapan lanjutan lebih koheren.

### Architecture
```
Sebelumnya:
  intent terdeteksi
    → inject raw JSON intent ke chat session (fire & forget)
    → plugin.handler() jalan
    → return true

Sekarang:
  intent terdeteksi
    → plugin.handler({ ...ctx, reply: interceptedReply, params }) jalan
    → teks reply terkirim ke WhatsApp owner (via interceptedReply)
    → capturedReply ada? → inject "[SYSTEM] Aksi intent..." ke chat session (fire & forget)
    → return true
```

---

## [2.3.0] — 2026-05-06

### Added
- `plugins/triggered/*.js` — field baru **`groupContextPrompt`** (string, opsional) pada setiap triggered plugin. Field ini berisi persona domain yang otomatis disimpan ke DB sebagai persona grup saat plugin di-assign sebagai channel `input` atau `both`. Plugin tanpa field ini tetap bisa di-assign ke grup, tapi persona grup tidak berubah.
- `core/triggeredPluginHandler.js` — export baru `getTriggeredPluginByKey(key)`: lookup satu triggered plugin berdasarkan intent name (case-insensitive). Dipakai `groupService` saat owner assign channel untuk mengambil `groupContextPrompt` dari plugin yang bersangkutan.

### Changed
- `services/groupService.js` — `setGroupChannel()` mendapat dua perubahan besar:
  - **Validasi satu plugin input per grup:** jika grup sudah punya plugin dengan role `input` atau `both`, request assign plugin input baru ditolak dengan pesan error yang menyebut plugin yang konflik. Untuk mengganti, owner harus hapus dulu plugin lama via `!group channel <groupJid> <pluginLama> none`.
  - **Sync persona otomatis:** saat plugin di-assign dengan role `input`/`both`, fungsi mengambil `groupContextPrompt` dari plugin via `getTriggeredPluginByKey()` dan menyimpannya ke DB sebagai persona grup (menggantikan persona yang ada). Saat plugin di-downgrade ke `output` atau dihapus (`none`) dan sebelumnya berstatus input, persona grup otomatis dikosongkan (kembali ke null).
  - Tambah import `getTriggeredPluginByKey` dari `triggeredPluginHandler.js`.
- `plugins/triggered/sendMessage.js` — ditambah field `groupContextPrompt` sebagai referensi contoh implementasi.
- `PLUGIN_SETUP.md` — diperbarui menyeluruh: field `groupContextPrompt` ditambahkan ke struktur file dan template triggered plugin, kedua contoh plugin diperbarui, section Group Channel System mendapat dua sub-section baru ("Aturan satu plugin input per grup" dan "Persona Otomatis dari Plugin"), `setGroupChannel` di API Lengkap diperbarui dengan komentar efek samping persona, contoh alur register grup diperluas dengan skenario end-to-end, checklist triggered plugin ditambah item `groupContextPrompt`, dan Ringkasan Cepat mendapat blok baru untuk tautkan plugin ke grup.

### Behavior
- Sebelumnya: owner harus set persona grup manual via `!group persona <teks>` setelah assign plugin ke grup. Tidak ada pembatasan jumlah plugin input per grup.
- Sekarang: persona grup otomatis diambil dari `groupContextPrompt` plugin saat assign `input`/`both` — tidak perlu `!group persona` manual. Satu grup hanya boleh punya satu plugin input; request kedua ditolak dengan pesan error eksplisit.

### Architecture
```
!group channel <groupJid> <pluginKey> input/both
  → validasi: ada plugin input lain? → jika ya, tolak dengan error
  → getTriggeredPluginByKey(pluginKey) → ambil plugin object
  → plugin.groupContextPrompt ada? → simpan ke DB sebagai persona grup
  → rebuild cache
  → (warmup session AI grup dengan persona baru dilakukan saat bot start berikutnya)

!group channel <groupJid> <pluginKey> none/output (dari role input sebelumnya)
  → persona grup otomatis dikosongkan (null)
  → rebuild cache
```

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