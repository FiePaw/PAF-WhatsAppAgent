# 🧩 PLUGIN SETUP GUIDE — WhatsApp AI Bot (PAF)

Panduan lengkap membuat plugin untuk bot WhatsApp ini: **Command Plugin**, **Triggered Plugin**, **Scheduled Plugin**, serta penggunaan **Database (db)**, **Cron Scheduler (cronService)**, dan **Group Channel System** di dalam plugin.

---

## 📁 Struktur Plugin

```
plugins/
├── help.js              ← Command plugin (!help)
├── ai.js                ← Command plugin (!ai)
├── reset.js             ← Command plugin (!reset)
├── agent.js             ← Command plugin (!status, !ping, dll)
├── persona.js           ← Command plugin (!persona)
├── reminder.js          ← Command plugin dengan db + cron (!remind)
├── group.js             ← Command plugin manajemen grup (!group)
│
├── triggered/           ← Triggered plugin (via intent detection)
│   └── sendMessage.js
│
└── scheduled/           ← Scheduled plugin (berjalan otomatis via cron)
    └── economicNews.js
```

Ada **tiga jenis plugin**:

| Jenis | Cara Aktif | Lokasi |
|---|---|---|
| **Command Plugin** | User ketik `!namaCommand` | `/plugins/*.js` |
| **Triggered Plugin** | AI mendeteksi intent dari percakapan | `/plugins/triggered/*.js` |
| **Scheduled Plugin** | Otomatis berdasarkan jadwal (cron) | `/plugins/scheduled/*.js` |

Semua jenis plugin dapat menggunakan **database JSON**, **group channel system** secara opsional. Command dan Triggered plugin juga bisa menggunakan **cron scheduler** via field `crons`.

---

## 1️⃣ Command Plugin

### Cara Kerja

1. User mengirim pesan diawali prefix (default: `!`), contoh: `!ping`
2. `messageHandler.js` mendeteksi bahwa pesan adalah command
3. `pluginLoader.js` mencari plugin yang memiliki command `ping` di `Map`
4. Handler plugin dipanggil dengan `ctx` (context object)

> ⚠️ **Grup terdaftar:** Command dari owner di dalam grup yang terdaftar juga diteruskan ke plugin yang sama. Lihat bagian **Group Channel System** untuk detail.

### Struktur File

Setiap command plugin harus `export default` sebuah object dengan shape berikut:

```js
// plugins/namaPlugin.js
export default {
  name: 'namaPlugin',          // Nama plugin (untuk log & help)
  description: 'Deskripsi singkat plugin ini',
  commands: ['cmd1', 'cmd2'],  // Command yang ditangani (tanpa prefix !)
  ownerOnly: false,            // true → hanya owner yang bisa pakai

  // OPTIONAL — lihat bagian Cron Scheduler untuk detail
  crons: [],

  handler: async (ctx) => {
    // logika plugin di sini
  },
};
```

### Context Object (`ctx`)

Handler menerima satu parameter `ctx` yang berisi:

| Property | Tipe | Keterangan |
|---|---|---|
| `sock` | object | Baileys socket — untuk kirim pesan, dll |
| `msg` | object | Baileys message object (raw) |
| `jid` | string | JID chat asal pesan (grup atau DM) |
| `sender` | string | JID pengirim pesan |
| `isOwner` | boolean | `true` jika pengirim adalah owner |
| `text` | string | Teks lengkap pesan (termasuk prefix & command) |
| `command` | string | Nama command tanpa prefix, huruf kecil |
| `args` | string[] | Argumen setelah command, dipisah spasi |
| `fullArgs` | string | Semua argumen setelah command (string utuh) |
| `reply` | async fn | Fungsi helper untuk membalas pesan dengan typing delay |
| `attachments` | Array\|null | Attachment gambar jika pesan berisi gambar, null jika tidak ada |
| `groupChannel` | object\|undefined | Info channel grup — hanya ada jika pesan berasal dari grup terdaftar |

#### Property `groupChannel` (jika ada)

```js
{
  input: boolean,    // apakah grup ini adalah input channel
  output: boolean,   // apakah grup ini adalah output channel
  plugins: string[], // list plugin key yang di-assign ke grup ini
  channels: object,  // mapping { pluginKey: 'input'|'output'|'both' }
  name: string,      // nama grup
}
```

### Fungsi `reply`

```js
await reply('Teks balasan kamu di sini');
```

- Otomatis mengirim typing indicator (`composing`) sebelum pesan
- Otomatis meng-quote pesan asli
- Delay dihitung berdasarkan panjang teks (anti-spam)

### Contoh: Command Plugin Sederhana

```js
// plugins/ping.js
export default {
  name: 'ping',
  description: 'Cek apakah bot aktif',
  commands: ['ping', 'p'],
  ownerOnly: false,

  handler: async ({ reply }) => {
    await reply('🏓 Pong! Bot aktif.');
  },
};
```

### Contoh: Command Plugin dengan Argumen

```js
// plugins/say.js
export default {
  name: 'say',
  description: 'Bot mengulangi pesan kamu',
  commands: ['say', 'echo'],
  ownerOnly: false,

  handler: async ({ fullArgs, reply }) => {
    if (!fullArgs) {
      await reply('❓ Contoh: !say Halo dunia');
      return;
    }
    await reply(fullArgs);
  },
};
```

### Contoh: Command Plugin Owner Only

```js
// plugins/broadcast.js
export default {
  name: 'broadcast',
  description: 'Kirim pesan ke semua session aktif (owner only)',
  commands: ['broadcast', 'bc'],
  ownerOnly: true,  // ← otomatis dicek oleh messageHandler.js

  handler: async ({ fullArgs, reply, sock }) => {
    if (!fullArgs) {
      await reply('❓ Gunakan: !bc <pesan>');
      return;
    }
    // logika broadcast...
    await reply(`✅ Broadcast terkirim: "${fullArgs}"`);
  },
};
```

> ⚠️ **Catatan:** Pengecekan `ownerOnly` dilakukan otomatis oleh `messageHandler.js` **sebelum** handler dipanggil di DM. Di grup terdaftar, semua command hanya bisa digunakan oleh owner — pengecekan sudah dilakukan di level `messageHandler.js`.

### Contoh: Command dengan Beberapa Sub-Command

```js
// plugins/info.js
export default {
  name: 'info',
  description: 'Informasi bot dan user',
  commands: ['info', 'whoami'],
  ownerOnly: false,

  handler: async ({ command, args, sender, jid, isOwner, reply }) => {
    if (command === 'whoami') {
      await reply(
        `👤 JID kamu: ${sender}\n` +
        `💬 Chat JID: ${jid}\n` +
        `👑 Owner: ${isOwner ? 'Ya' : 'Tidak'}`
      );
      return;
    }

    // default: !info
    await reply(`ℹ️ PAF WhatsApp AI Bot`);
  },
};
```

### Mengirim Pesan Tanpa `reply` (Lebih Fleksibel)

Kamu bisa menggunakan `sock` langsung untuk kebutuhan yang lebih kompleks:

```js
handler: async ({ sock, jid, msg, reply }) => {
  // Kirim teks biasa
  await sock.sendMessage(jid, { text: 'Halo!' });

  // Kirim gambar
  await sock.sendMessage(jid, {
    image: { url: 'https://example.com/img.jpg' },
    caption: 'Keterangan gambar',
  });

  // Kirim ke nomor lain (bukan ke chat asal)
  const targetJid = '628111111111@s.whatsapp.net';
  await sock.sendMessage(targetJid, { text: 'Pesan rahasia' });
},
```

---

## 2️⃣ Triggered Plugin

### Cara Kerja

1. Owner mengirim pesan **tanpa prefix** (teks atau gambar, dengan/tanpa caption) — di DM maupun di grup terdaftar yang punya `input` channel
2. `messageHandler.js` mengekstrak teks dan gambar (jika ada):
   - Gambar di-download, dikonversi ke base64, dan dikemas sebagai `attachments`
   - Jika gambar tanpa caption, `intentText` = `"[gambar dikirim]"` agar intent session tetap punya konteks
3. `messageHandler.js` menjalankan **dua proses paralel**:
   - Intent detection via `intentSessionService.js` (kirim teks + gambar ke Qwen)
   - AI chat biasa via `aiService.js` (kirim teks + gambar ke Qwen)
4. Jika Qwen mendeteksi intent (return JSON `{ intent: "...", params: {...} }`):
   - Triggered plugin yang sesuai dijalankan
   - Reply dari plugin di-intercept → dikirim ke **chat session** sebagai konteks sistem (fire & forget) — agar chat session memahami hasil eksekusi plugin, mencegah missed context
   - Hasil AI chat **dibuang** (tidak dikirim ke owner)
5. Jika tidak ada intent → hasil AI chat dikirim ke owner

> ⚠️ **Triggered plugin hanya aktif untuk owner.** Non-owner hanya mendapat AI chat biasa (dengan gambar jika ada).
> Di grup terdaftar, intent detection hanya berjalan jika grup memiliki role `input` atau `both`.

### Struktur File

Setiap triggered plugin **wajib** export `intent`, `intentDefinition`, dan `handler`. Field `groupContextPrompt` bersifat opsional tapi **sangat direkomendasikan** jika plugin akan digunakan sebagai channel input grup:

```js
// plugins/triggered/namaPlugin.js
export default {
  intent: 'namaIntent',         // harus cocok dengan intent yang dikembalikan Qwen (case-insensitive)

  intentDefinition: `"namaIntent" - deskripsi kapan intent ini aktif. Ekstrak: param1 (tipe, keterangan), param2 (tipe, keterangan).`,
  // ↑ di-inject otomatis ke system prompt intent session Qwen saat bot start

  groupContextPrompt: `Teks persona yang akan otomatis menjadi persona grup saat plugin ini di-assign sebagai channel input/both.`,
  // ↑ otomatis disimpan ke DB sebagai persona grup saat !group channel <groupJid> namaIntent input/both
  // ↑ jika tidak diisi, persona grup tidak berubah saat plugin di-assign

  // OPTIONAL — metadata untuk log
  name: 'Nama Plugin',
  description: 'Deskripsi singkat',
  ownerOnly: true,

  handler: async (ctx) => {
    // logika triggered plugin di sini
  },
};
```

> ⚠️ Plugin tanpa `intentDefinition` tetap bisa di-load dan berjalan, tapi Qwen **tidak akan pernah mengenali intent tersebut** karena tidak masuk ke system prompt. Pastikan selalu mengisi `intentDefinition`.

> ℹ️ Plugin tanpa `groupContextPrompt` tetap bisa di-assign ke grup, tapi persona grup **tidak akan berubah** — grup tetap memakai persona yang sudah ada sebelumnya (atau null).

### Context Object Triggered Plugin (`ctx`)

Sama seperti command plugin, **ditambah dua property**:

| Property | Tipe | Keterangan |
|---|---|---|
| `params` | object | Parameter yang diekstrak Qwen dari percakapan atau gambar |
| `attachments` | Array\|null | Attachment gambar jika pesan berisi gambar, null jika tidak ada |
| `sock` | object | Baileys socket |
| `msg` | object | Baileys message object |
| `jid` | string | JID chat asal pesan |
| `sender` | string | JID pengirim (owner) |
| `isOwner` | boolean | Selalu `true` untuk triggered plugin |
| `text` | string | Teks pesan atau `"[gambar dikirim]"` jika gambar tanpa caption |
| `reply` | async fn | Fungsi reply dengan typing delay |
| `groupChannel` | object\|undefined | Info channel grup — ada jika triggered dari grup terdaftar |

### Mendaftarkan Intent ke Qwen

Intent detector di `intentSessionService.js` memiliki **base system prompt** yang mendefinisikan peran dan format output Qwen (selalu JSON, tidak boleh teks biasa). Daftar intent yang Qwen kenali **tidak lagi hardcoded** di sana — melainkan dikumpulkan secara otomatis dari field `intentDefinition` di setiap triggered plugin.

**Alur build system prompt saat bot start:**

```
initOwnerIntentSession()
  → _buildSystemPrompt()
      → lazy import getIntentDefinitions() dari triggeredPluginHandler.js
      → kumpulkan intentDefinition dari semua plugin yang sudah di-load
      → gabungkan: BASE_PROMPT + daftar intent
  → kirim ke Qwen → simpan session ID
```

Artinya: **cukup definisikan `intentDefinition` di plugin itu sendiri** — tidak perlu menyentuh `intentSessionService.js` sama sekali.

Format `intentDefinition` yang baik:

```
"namaIntent" - deskripsi kapan intent ini aktif.
  Ekstrak: param1 (tipe, keterangan), param2 (tipe, keterangan).
  Kondisi khusus jika ada.
```

### Sinkronisasi Context: Intent Session → Chat Session

Setiap kali triggered plugin dijalankan, reply yang dikirim plugin ke owner di-**intercept** dan diteruskan ke **chat session** sebagai konteks sistem:

```js
// Yang terjadi di triggeredPluginHandler.js:

// 1. Wrap reply untuk intercept teks yang dikirim plugin
let capturedReply = null;
const interceptedReply = async (replyText) => {
  capturedReply = replyText;
  await ctx.reply(replyText); // tetap kirim ke WhatsApp seperti biasa
};

// 2. Jalankan plugin dengan reply yang sudah di-intercept
await plugin.handler({ ...ctx, reply: interceptedReply, params });

// 3. Inject hasil plugin ke chat session (fire & forget)
if (capturedReply) {
  const systemContext = `[SYSTEM] Aksi intent "${intent}" telah dieksekusi. Hasilnya: ${capturedReply}`;
  askAI({ jid, userText: systemContext, systemPrompt: null }); // tidak di-await
}
```

**Tujuannya:** chat session AI di grup (atau DM) selalu tahu hasil aksi yang baru saja dieksekusi oleh bot — sehingga percakapan lanjutan tetap koheren.

**Contoh tanpa sinkronisasi (before):**
```
Owner: "catat pengeluaran 50rb buat makan siang"
  → intent: recordExpense { amount: 50000, category: 'makan' }
  → plugin catat ke DB, reply: "✅ Pengeluaran 50rb (makan siang) berhasil dicatat" ✅
Owner: "tadi berapa yang aku catat?"
  → chat session tidak tahu → AI menjawab "Maaf, saya tidak tahu" ❌
```

**Contoh dengan sinkronisasi (after):**
```
Owner: "catat pengeluaran 50rb buat makan siang"
  → intent: recordExpense { amount: 50000, category: 'makan' }
  → plugin catat ke DB, reply: "✅ Pengeluaran 50rb (makan siang) berhasil dicatat" ✅
  → inject ke chat session: "[SYSTEM] Aksi intent "recordExpense" telah dieksekusi.
     Hasilnya: ✅ Pengeluaran 50rb (makan siang) berhasil dicatat"
Owner: "tadi berapa yang aku catat?"
  → chat session sudah punya konteks → AI menjawab "50.000 untuk makan siang" ✅
```

> ℹ️ Inject dilakukan **fire & forget** (tidak di-await) — tidak menambah latency ke plugin handler. Jika inject gagal (misal AI server down), plugin handler tetap jalan normal dan warning dicatat di log.

> ℹ️ Jika plugin tidak memanggil `reply` sama sekali (plugin silent), inject tidak dilakukan.

> ℹ️ Key chat session yang dipakai adalah `jid` (JID chat asal pesan) — bukan `sender`. Ini memastikan context masuk ke session yang tepat: grup Finance mendapat context hasil plugin Finance, DM mendapat context hasil plugin DM.

### Contoh: Triggered Plugin Sederhana

```js
// plugins/triggered/setReminder.js
export default {
  intent: 'setReminder',
  intentDefinition: `"setReminder" - owner ingin membuat pengingat pada waktu tertentu. Ekstrak: time (string, format HH:MM) dan message (string, isi pengingat). Intent valid hanya jika waktu eksplisit disebutkan.`,
  groupContextPrompt: `Kamu adalah asisten pengingat pribadi owner. Kamu memahami bahwa owner sering meminta untuk membuat pengingat pada waktu tertentu. Bantu owner mengelola jadwal dan pengingat dengan efisien. Jawab ringkas dalam Bahasa Indonesia.`,

  handler: async ({ params, reply }) => {
    const { time, message } = params;

    if (!time || !message) {
      await reply('⚠️ Tidak cukup info untuk membuat pengingat.');
      return;
    }

    await reply(`⏰ Pengingat diset untuk jam ${time}: "${message}"`);
  },
};
```

### Contoh: Triggered Plugin Kirim Pesan (Referensi Existing)

```js
// plugins/triggered/sendMessage.js
export default {
  intent: 'sendMessage',
  intentDefinition: `"sendMessage" - owner ingin mengirim pesan ke nomor WhatsApp lain. Ekstrak: targetNumber (string, angka saja tanpa + atau spasi, format internasional 628xxx) dan message (string, isi pesan yang ingin disampaikan, tulis ulang secara natural orang pertama sesuai maksud owner). Intent ini valid hanya jika nomor target eksplisit disebutkan.`,
  groupContextPrompt: `Kamu adalah asisten pengiriman pesan pribadi owner. Kamu memahami bahwa owner sering meminta untuk mengirimkan pesan ke kontak tertentu melalui WhatsApp. Bantu owner merumuskan pesan yang natural dan sesuai konteks. Jawab ringkas seperti chat biasa dalam Bahasa Indonesia.`,

  handler: async ({ params, sock, reply }) => {
    const { targetNumber, message } = params;

    if (!targetNumber || !message) {
      await reply('⚠️ Nomor tujuan atau pesan tidak terdeteksi dengan jelas.');
      return;
    }

    const targetJid = `${targetNumber.replace(/\D/g, '')}@s.whatsapp.net`;

    try {
      await sock.sendMessage(targetJid, { text: message });
      await reply(`✅ Pesan terkirim ke *${targetNumber}*:\n"${message}"`);
    } catch (err) {
      await reply(`❌ Gagal kirim pesan ke ${targetNumber}.`);
    }
  },
};
```

---

## 3️⃣ AI Service (`aiService`)

Plugin dapat memanggil `askAI` langsung untuk generate konten dari Qwen — berguna untuk scheduled plugin atau plugin yang butuh response AI di luar alur chat biasa.

### Import

```js
// Dari /plugins/namaPlugin.js
import { askAI } from '../services/aiService.js';

// Dari /plugins/triggered/ atau /plugins/scheduled/
import { askAI } from '../../services/aiService.js';
```

### API

```js
const response = await askAI({
  jid: 'scheduled:namaJob',  // key session — gunakan key unik agar tidak bercampur dengan session chat
  userText: 'Prompt ke Qwen',
  systemPrompt: 'Peran dan instruksi Qwen',  // opsional

  thinkMode: 'auto',         // opsional — "auto" | "thinking" | "fast" (default server: "fast")
  attachments: [],           // opsional — array attachment gambar (lihat format di bawah)
});
```

### `thinkMode`

Kontrol kedalaman reasoning Qwen:

| Nilai | Kapan dipakai |
|---|---|
| `"fast"` | Intent detection, klasifikasi sederhana, reply singkat |
| `"auto"` | Default — Qwen memilih sendiri sesuai kompleksitas |
| `"thinking"` | Analisis mendalam, coding kompleks, reasoning multi-langkah |

```js
// Contoh: analisis laporan keuangan dengan reasoning mendalam
const analysis = await askAI({
  jid: 'scheduled:financeReport',
  userText: 'Analisis pola pengeluaran bulan ini dan berikan rekomendasi.',
  systemPrompt: 'Kamu adalah analis keuangan pribadi.',
  thinkMode: 'thinking',
});
```

### `attachments` — Kirim Gambar ke Qwen

Format attachment yang diterima:

```js
attachments: [
  {
    filename: 'struk.jpg',        // nama file
    data: '<base64 string>',      // isi file dalam base64
    mime_type: 'image/jpeg',      // opsional — default server mendeteksi otomatis
  }
]
```

Gambar yang dikirim user via WhatsApp sudah otomatis dikemas sebagai `attachments` oleh `messageHandler.js` dan tersedia di `ctx.attachments`. Plugin dapat meneruskannya langsung ke `askAI`:

```js
// Di triggered plugin — gambar struk → ekstrak data keuangan
handler: async ({ params, attachments, reply }) => {
  if (attachments) {
    const extracted = await askAI({
      jid: 'triggered:extractReceipt',
      userText: 'Ekstrak nominal, kategori, dan tanggal dari struk ini.',
      systemPrompt: 'Kamu adalah asisten pencatatan keuangan. Ekstrak data dari gambar struk dan return JSON.',
      thinkMode: 'auto',
      attachments,
    });
    // proses extracted...
  }
}
```

> ℹ️ `ctx.attachments` bernilai `null` jika pesan tidak mengandung gambar. Selalu guard sebelum digunakan:
> ```js
> if (ctx.attachments) { /* ada gambar */ }
> ```

---

## 4️⃣ Database JSON (`db`)

Bot menyediakan database JSON ringan berbasis file. Setiap **collection** disimpan sebagai satu file di folder `/data/<collection>.json`. Database ini dapat digunakan oleh **semua jenis plugin**.

### Import

```js
// Dari /plugins/namaPlugin.js
import db from '../services/db.js';

// Dari /plugins/triggered/namaPlugin.js
import db from '../../services/db.js';
```

### API Lengkap

#### `db.insert(collection, doc)` — Sisipkan dokumen baru
```js
const newDoc = await db.insert('reminders', {
  jid: '628xxx@s.whatsapp.net',
  message: 'Cek server',
  dueAt: Date.now() + 60000,
  sent: false,
});
// newDoc._id dan newDoc.createdAt otomatis diisi
```

#### `db.findOne(collection, query)` — Cari satu dokumen
```js
const reminder = db.findOne('reminders', { _id: '1234_abc' });
// Mengembalikan object dokumen atau null
```

#### `db.find(collection, query)` — Cari semua dokumen yang cocok
```js
// Cari semua reminder yang belum terkirim
const pending = db.find('reminders', { sent: false });

// Query kosong → ambil semua dokumen
const all = db.find('reminders', {});
```

#### `db.update(collection, query, updates)` — Update dokumen pertama yang cocok
```js
await db.update('reminders', { _id: '1234_abc' }, { sent: true });
// Field updatedAt otomatis diisi
```

#### `db.upsert(collection, query, doc)` — Update jika ada, insert jika tidak ada
```js
await db.upsert('settings', { key: 'autoReply' }, { value: true });
```

#### `db.delete(collection, query)` — Hapus semua dokumen yang cocok
```js
const removed = await db.delete('reminders', { jid, sent: true });
// Mengembalikan jumlah dokumen yang dihapus
```

#### `db.clear(collection)` — Hapus seluruh isi collection
```js
await db.clear('reminders');
```

#### `db.count(collection, query)` — Hitung dokumen
```js
const total = db.count('reminders', { sent: false });
```

### Catatan Penting

- `insert`, `update`, `upsert`, `delete`, `clear` adalah `async` — selalu gunakan `await`
- `findOne`, `find`, `count` adalah **synchronous** (tidak perlu `await`)
- Nama collection bebas — file JSON dibuat otomatis di `/data/`
- Query menggunakan **shallow key-value match** (cocokkan nilai exact per field)
- Query tidak mendukung operator seperti `$gt`, `$lt`, dll — filter lanjutan lakukan manual di JS:
  ```js
  const due = db.find('reminders', {}).filter(r => !r.sent && r.dueAt <= Date.now());
  ```

---

## 4️⃣ Cron Scheduler (`cronService`)

Bot menyediakan scheduler berbasis cron untuk menjalankan tugas terjadwal. Plugin dapat mendaftarkan cron job melalui field `crons` di export default-nya — **tidak perlu memanggil cronService secara manual**.

### Cara Mendaftarkan Cron Job di Plugin

Tambahkan field `crons` (array) ke export default plugin:

```js
export default {
  name: 'namaPlugin',
  commands: ['cmd'],
  ownerOnly: false,

  crons: [
    {
      name: 'namaPlugin:namaJob',   // nama unik, gunakan format "plugin:job"
      expr: '0 9 * * *',           // cron expression (setiap hari jam 09:00)
      handler: async () => {
        // logika yang dijalankan sesuai jadwal
      },
      runOnRegister: false,        // optional: jalankan sekali langsung saat bot start
    },
  ],

  handler: async (ctx) => { /* ... */ },
};
```

`pluginLoader.js` akan mendaftarkan semua job ke `cronService` secara otomatis saat bot start. Job mulai berjalan setelah koneksi WhatsApp terbuka (`connection.open`).

### Format Cron Expression

```
* * * * *
│ │ │ │ └── hari dalam seminggu (0–7, 0 dan 7 = Minggu)
│ │ │ └──── bulan (1–12)
│ │ └────── tanggal (1–31)
│ └──────── jam (0–23)
└────────── menit (0–59)
```

**Alias yang tersedia:**

| Alias | Setara dengan | Arti |
|---|---|---|
| `@hourly` | `0 * * * *` | Setiap jam |
| `@daily` | `0 0 * * *` | Setiap hari tengah malam |
| `@weekly` | `0 0 * * 0` | Setiap Minggu tengah malam |
| `@monthly` | `0 0 1 * *` | Tanggal 1 tiap bulan |
| `@yearly` | `0 0 1 1 *` | Tanggal 1 Januari |
| `@every_<N>s` | interval | Setiap N detik, contoh: `@every_30s` |

**Contoh ekspresi:**

```
* * * * *        → Setiap menit
*/5 * * * *      → Setiap 5 menit
0 9 * * *        → Setiap hari jam 09:00
0 9 * * 1        → Setiap Senin jam 09:00
0 */2 * * *      → Setiap 2 jam
@every_60s       → Setiap 60 detik
@daily           → Setiap hari tengah malam
```

### Mengakses `cronService` Langsung (Opsional)

Jika perlu mengontrol job secara dinamis dari dalam handler:

```js
import cronService from '../services/cronService.js';

// Daftarkan job baru secara runtime
cronService.register('namaJob', '@every_30s', async () => {
  // logika...
}, { autoStart: true });

// Start / stop job tertentu
cronService.start('namaJob');
cronService.stop('namaJob');

// Lihat semua job
const jobs = cronService.list();
// [{ name, expr, running, lastRun, runCount }, ...]

// Hapus job
cronService.unregister('namaJob');
```

### Contoh Plugin dengan Cron + Database

```js
// plugins/dailyReport.js
import db from '../services/db.js';
import logger from '../utils/logger.js';

let _sock = null;
const OWNER_JID = process.env.OWNER_NUMBER + '@s.whatsapp.net';

export default {
  name: 'dailyReport',
  description: 'Kirim laporan harian ke owner tiap pagi',
  commands: ['reportstatus'],
  ownerOnly: true,

  crons: [
    {
      name: 'dailyReport:send',
      expr: '0 8 * * *',  // setiap hari jam 08:00
      handler: async () => {
        if (!_sock) return;
        const count = db.count('messages', {});
        await _sock.sendMessage(OWNER_JID, {
          text: `📊 *Laporan Harian*\nTotal pesan diproses: ${count}`,
        });
        logger.info('📊 Daily report terkirim');
      },
    },
  ],

  handler: async ({ sock, reply }) => {
    _sock = sock;
    const count = db.count('messages', {});
    await reply(`📊 Total pesan diproses hari ini: ${count}`);
  },
};
```

> ⚠️ **Pattern `_sock`:** Karena cron job berjalan di luar konteks `ctx`, referensi `sock` perlu disimpan ke variabel modul saat handler pertama kali dipanggil. Lihat contoh di atas dan `plugins/reminder.js`.

---

## 5️⃣ Group Channel System (`groupService`)

Bot mendukung sistem **grup sebagai channel dua arah** — input dan output — untuk plugin tertentu. Grup yang terdaftar bisa menjadi sumber perintah (input) sekaligus tujuan output notifikasi dari plugin.

### Konsep

| Role | Arti |
|---|---|
| `input` | Owner bisa kirim command atau pesan natural di grup ini → diteruskan ke plugin terkait + AI chat |
| `output` | Plugin bisa mengirim output/notifikasi ke grup ini |
| `both` | Keduanya — grup berfungsi sebagai input sekaligus output |
| `none` | Hapus assignment channel dari grup |

Satu grup bisa di-assign ke **beberapa plugin key** dengan role berbeda. Contoh: grup "Ops" bisa jadi `output` untuk `reminder` dan `both` untuk `broadcast`.

> ⚠️ **Aturan: satu plugin input per grup.** Setiap grup hanya boleh memiliki **satu** plugin dengan role `input` atau `both`. Jika owner mencoba assign plugin input kedua, request akan ditolak dengan pesan error yang menyebut plugin yang konflik. Untuk mengganti plugin input, hapus dulu yang lama dengan `!group channel <groupJid> <pluginLama> none`.

### Persona Otomatis dari Plugin

Saat owner assign plugin dengan role `input` atau `both` ke sebuah grup, sistem otomatis mengambil field `groupContextPrompt` dari plugin tersebut dan menyimpannya sebagai **persona grup** — menggantikan persona yang ada sebelumnya.

```
!group channel <groupJid> finance both
  → cek ada plugin input lain? → tidak → lanjut
  → ambil finance.groupContextPrompt
  → simpan ke DB sebagai persona grup
  → rebuild cache → warmup session AI grup dengan persona baru
```

Ini berarti:
- Owner **tidak perlu set persona manual** via `!group persona` jika grup sudah ditautkan ke plugin yang punya `groupContextPrompt`
- Saat plugin di-downgrade ke `output` atau dihapus (`none`), persona grup otomatis dikosongkan (kembali ke null → fallback ke persona owner)
- Plugin tanpa `groupContextPrompt` → persona grup tidak berubah saat di-assign

### Alur Pesan di Grup

```
Pesan masuk dari grup
    │
    ├─ Grup tidak terdaftar?
    │     ├─ Owner ketik !group register → daftarkan grup otomatis
    │     └─ Pesan lain → diabaikan
    │
    └─ Grup terdaftar?
          ├─ Bukan owner → diabaikan
          ├─ isCommand?
          │     ├─ Command dikenal → jalankan plugin (ctx.groupChannel tersedia)
          │     └─ Command tidak dikenal → diam (tidak reply error)
          └─ Pesan natural owner
                ├─ Grup punya input channel → intent detection + AI chat paralel
                └─ Grup tidak punya input channel → AI chat saja
```

### Import

```js
// Dari /plugins/namaPlugin.js
import {
  getGroupOutput,
  getGroupInput,
  getGroupChannel,
  findGroup,
  listGroups,
  registerGroup,
  setGroupChannel,
  createGroup,
  deleteGroup,
} from '../services/groupService.js';

// Dari /plugins/triggered/namaPlugin.js
import { getGroupOutput } from '../../services/groupService.js';
```

### API Lengkap

#### `getGroupOutput(pluginKey)` — Dapatkan JID grup output untuk plugin
```js
// Dipakai plugin untuk mengirim output/notifikasi ke grup
const groupJids = getGroupOutput('reminder');
// → ['120363xxx@g.us', '120363yyy@g.us']

for (const groupJid of groupJids) {
  await sock.sendMessage(groupJid, { text: '⏰ Reminder: Meeting 5 menit lagi!' });
}
```

#### `getGroupInput(pluginKey)` — Dapatkan JID grup input untuk plugin
```js
// Cek grup mana yang terdaftar sebagai input untuk plugin ini
const inputGroups = getGroupInput('reminder');
```

#### `getGroupChannel(groupJid)` — Cek status channel sebuah grup
```js
// Dipakai messageHandler — jarang dibutuhkan langsung dari plugin
const channel = getGroupChannel('120363xxx@g.us');
// → { input: true, output: false, plugins: ['reminder'], channels: { reminder: 'input' }, name: 'Grup Reminder' }
// → null jika grup tidak terdaftar
```

#### `findGroup(groupJid)` — Cari data grup dari DB
```js
const group = findGroup('120363xxx@g.us');
// → { _id, groupJid, name, channels, createdAt } atau null
```

#### `listGroups()` — Daftar semua grup terdaftar
```js
const groups = listGroups();
// → [{ _id, groupJid, name, channels, createdAt }, ...]
```

#### `registerGroup(groupJid, groupName)` — Daftarkan grup existing
```js
const result = await registerGroup('120363xxx@g.us', 'Grup Reminder');
// → { success: true } atau { success: false, error: '...' }
```

#### `setGroupChannel(groupJid, pluginKey, role)` — Set channel plugin pada grup
```js
await setGroupChannel('120363xxx@g.us', 'reminder', 'both');
// → jika berhasil: persona grup otomatis diambil dari reminder.groupContextPrompt (jika ada)
// → jika grup sudah punya plugin input lain: { success: false, error: '...' }

await setGroupChannel('120363xxx@g.us', 'broadcast', 'output');
// → role output tidak mempengaruhi persona grup

await setGroupChannel('120363xxx@g.us', 'reminder', 'none');
// → hapus assignment, persona grup dari plugin otomatis dihapus (kembali ke null)
```

#### `createGroup(sock, groupName)` — Buat grup baru via Baileys
```js
const result = await createGroup(sock, 'Nama Grup Baru');
// → { success: true, groupJid: '120363xxx@g.us', name: 'Nama Grup Baru' }
// → { success: false, error: '...' }
```

#### `deleteGroup(sock, groupJid)` — Bot leave dan hapus dari daftar
```js
const result = await deleteGroup(sock, '120363xxx@g.us');
// → { success: true } atau { success: false, error: '...' }
```

### Contoh: Plugin yang Kirim Output ke Grup

```js
// plugins/reminder.js (contoh penggunaan getGroupOutput)
import { getGroupOutput } from '../services/groupService.js';

// Di dalam cron handler atau bagian manapun yang perlu kirim notifikasi:
async function sendReminderNotification(sock, message) {
  // Kirim ke owner via DM
  await sock.sendMessage(config.ownerJid, { text: message });

  // Kirim juga ke semua grup yang di-assign sebagai output untuk 'reminder'
  const outputGroups = getGroupOutput('reminder');
  for (const groupJid of outputGroups) {
    await sock.sendMessage(groupJid, { text: message });
  }
}
```

### Contoh: Plugin yang Sadar Konteks Grup

```js
// plugins/myPlugin.js
export default {
  name: 'myPlugin',
  commands: ['cmd'],
  ownerOnly: true,

  handler: async ({ jid, args, reply, groupChannel }) => {
    // Cek apakah perintah datang dari grup atau DM
    if (groupChannel) {
      // Perintah dari grup terdaftar
      await reply(`📍 Perintah diterima dari grup: *${groupChannel.name}*`);
    } else {
      // Perintah dari DM
      await reply('💬 Perintah diterima dari DM');
    }
  },
};
```

### Commands Manajemen Grup (`!group`)

Plugin `group.js` menyediakan command lengkap untuk owner mengelola grup:

| Command | Keterangan |
|---|---|
| `!group create <nama>` | Buat grup baru, owner otomatis dimasukkan |
| `!group delete <groupJid>` | Bot keluar dan hapus grup dari daftar |
| `!group register [nama]` | Di dalam grup: daftarkan grup ini otomatis. Dari DM: `!group register <groupJid> <nama>` |
| `!group list` | Tampilkan semua grup terdaftar beserta channel-nya |
| `!group info [groupJid]` | Detail grup. Di dalam grup: tanpa args → info grup ini |
| `!group channel <groupJid> <pluginKey> <role>` | Set channel plugin pada grup |

**Contoh alur register dan setup grup baru:**
```
1. Owner masuk ke grup yang belum terdaftar
2. Ketik: !group register
   → Bot otomatis ambil JID dan nama grup dari metadata
   → Reply: "✅ Grup ini berhasil didaftarkan!"
3. Ketik: !group channel 120363xxx@g.us finance both
   → Grup ini sekarang jadi input+output untuk plugin finance
   → Persona grup otomatis diset dari finance.groupContextPrompt
   → Owner tidak perlu !group persona manual
4. Owner chat natural di grup: "catat pengeluaran 50rb buat makan siang"
   → Intent detection menangkap → plugin finance handler dipanggil
   → Chat session AI grup juga punya konteks keuangan dari persona plugin
```

**Mengganti plugin input:**
```
!group channel 120363xxx@g.us finance none   ← hapus dulu plugin lama
!group channel 120363xxx@g.us reminder both  ← baru assign plugin baru
```

---

## 🔧 Menggunakan Service yang Ada

Kamu bisa import service-service yang sudah tersedia ke dalam plugin:

### `aiService.js` — Tanya AI

```js
import { askAI } from '../services/aiService.js';

const response = await askAI({
  jid: sender,           // key sesi per user
  userText: 'Halo!',
  systemPrompt: 'Kamu adalah asisten yang membantu.',
});
```

### `sessionStore.js` — Kelola Sesi Chat

```js
import { sessionStore } from '../services/sessionStore.js';

sessionStore.get(jid);        // ambil session ID
sessionStore.set(jid, id);    // simpan session ID
sessionStore.delete(jid);     // hapus session (reset chat)
sessionStore.list();          // list semua session aktif
```

### `personaService.js` — Kelola Persona

```js
import {
  getPersona,
  setPersona,
  deletePersona,
  setGlobalPersona,
  listPersonas,
} from '../services/personaService.js';

getPersona(senderJid, isOwner);         // ambil persona user
setPersona(senderJid, 'teks persona');  // set persona spesifik user
deletePersona(senderJid);               // hapus persona user (kembali ke default)
setGlobalPersona('owner', '...');       // update persona owner
setGlobalPersona('default', '...');     // update persona global
listPersonas();                         // list semua persona
```

### `intentSessionService.js` — Kelola Intent Session

```js
import {
  listIntentSessions,
  deleteIntentSession,
  resetSystemPromptCache,
} from '../services/intentSessionService.js';

listIntentSessions();            // list semua intent session aktif
deleteIntentSession(senderJid);  // hapus intent session (akan di-reinit otomatis)
resetSystemPromptCache();        // reset cache system prompt (rebuild dari plugin saat reinit)
```

### `groupService.js` — Group Channel System

```js
import {
  getGroupOutput,
  getGroupInput,
  listGroups,
  findGroup,
} from '../services/groupService.js';

getGroupOutput('reminder');   // JID grup yang jadi output untuk 'reminder'
getGroupInput('reminder');    // JID grup yang jadi input untuk 'reminder'
listGroups();                 // semua grup terdaftar
findGroup(groupJid);          // cari satu grup berdasarkan JID
```

### `db.js` — Database JSON

```js
import db from '../services/db.js';

await db.insert('collection', { field: 'value' });
db.find('collection', { field: 'value' });
await db.update('collection', { _id: '...' }, { field: 'newValue' });
await db.delete('collection', { field: 'value' });
```

### `cronService.js` — Scheduler

```js
import cronService from '../services/cronService.js';

cronService.register('jobName', '* * * * *', async () => { /* ... */ });
cronService.start('jobName');
cronService.stop('jobName');
cronService.list();
```

---

## ✅ Checklist Membuat Plugin

### Command Plugin

- [ ] File ada di `/plugins/` (bukan di subfolder `triggered/`)
- [ ] Nama file tidak diawali `_` (file dengan `_` diabaikan oleh loader)
- [ ] File menggunakan `export default { ... }`
- [ ] Ada property `name`, `description`, `commands` (array), `ownerOnly`, `handler`
- [ ] `handler` adalah `async function`
- [ ] Semua balasan menggunakan `await reply(...)` atau `await sock.sendMessage(...)`
- [ ] Tidak ada try/catch yang menelan error secara diam-diam (log atau re-throw)
- [ ] Jika ada `crons`, setiap entry memiliki `name` unik (format: `pluginName:jobName`), `expr` valid, dan `handler` async
- [ ] Jika plugin support grup, gunakan `groupChannel` dari ctx untuk bedakan DM vs grup

### Triggered Plugin

- [ ] File ada di `/plugins/triggered/`
- [ ] Nama file tidak diawali `_`
- [ ] File menggunakan `export default { intent, intentDefinition, handler }`
- [ ] `intent` cocok **persis** dengan intent yang akan dikembalikan Qwen (case-insensitive)
- [ ] `intentDefinition` diisi dengan deskripsi jelas: kapan aktif + params apa yang diekstrak
- [ ] `groupContextPrompt` diisi jika plugin akan digunakan sebagai channel input grup — persona grup otomatis diset dari field ini
- [ ] Tidak perlu menyentuh `intentSessionService.js` — sistem otomatis inject `intentDefinition` ke system prompt Qwen
- [ ] Selalu validasi `params` sebelum digunakan (Qwen bisa returnkan params kosong)
- [ ] Handler mengembalikan balasan yang jelas ke owner

### Plugin dengan Database

- [ ] Gunakan nama collection yang deskriptif dan konsisten (contoh: `reminders`, `settings`, `logs`)
- [ ] Selalu `await` operasi tulis (`insert`, `update`, `upsert`, `delete`, `clear`)
- [ ] Gunakan `findOne`/`find`/`count` tanpa `await` (synchronous)
- [ ] Filter kompleks (range, kondisi) dilakukan di JS setelah `find()`

### Plugin dengan Cron

- [ ] Nama job unik secara global — gunakan prefix nama plugin (contoh: `reminder:checkDue`)
- [ ] Jika cron job butuh `sock`, simpan referensi di variabel modul dari handler
- [ ] Tangani error di dalam cron handler (error tidak ter-caught otomatis)
- [ ] Uji cron expression di [crontab.guru](https://crontab.guru) sebelum dipakai

### Plugin dengan Group Channel Output

- [ ] Import `getGroupOutput` dari `groupService.js`
- [ ] Panggil `getGroupOutput('pluginKey')` untuk dapatkan list JID grup tujuan
- [ ] Loop hasilnya dan kirim via `sock.sendMessage(groupJid, { text: ... })`
- [ ] Dokumentasikan `pluginKey` yang digunakan agar owner tahu cara set channel via `!group channel`

---

## ⚠️ Hal-hal yang Perlu Diperhatikan

### Path Import

Sesuaikan path relatif berdasarkan lokasi file plugin:

```js
// Dari /plugins/namaPlugin.js
import { askAI } from '../services/aiService.js';
import { getGroupOutput } from '../services/groupService.js';
import db from '../services/db.js';
import cronService from '../services/cronService.js';
import config from '../config/config.js';
import logger from '../utils/logger.js';

// Dari /plugins/triggered/namaPlugin.js
import { askAI } from '../../services/aiService.js';
import { getGroupOutput } from '../../services/groupService.js';
import db from '../../services/db.js';
import cronService from '../../services/cronService.js';
import config from '../../config/config.js';
import logger from '../../utils/logger.js';
```

### Plugin Tidak Perlu Restart untuk Development? Tidak.

`pluginLoader.js` memuat plugin saat bot **pertama kali start**. Cron job juga didaftarkan hanya saat start. Jika kamu menambah atau mengubah plugin, **selalu restart bot**.

### Jangan Throw Error di Handler

Error yang tidak ditangkap di handler akan ditangkap oleh `messageHandler.js`, tapi pesan error generik yang dikirim ke user kurang informatif. Tangani error di dalam handler:

```js
handler: async ({ reply }) => {
  try {
    // logika...
  } catch (err) {
    logger.error({ err: err.message }, 'Error di plugin X');
    await reply('⚠️ Terjadi kesalahan. Coba lagi nanti.');
  }
},
```

### `ownerOnly` di Command Plugin

Pengecekan dilakukan **otomatis sebelum handler dipanggil** (di DM). Di grup terdaftar, semua interaksi sudah dibatasi hanya untuk owner di level `messageHandler.js`. Tidak perlu cek `isOwner` di dalam handler untuk keperluan ini.

### Command di Grup — Diam jika Tidak Dikenal

Berbeda dengan DM yang membalas "command tidak dikenal", di grup yang terdaftar bot **tidak membalas** jika command tidak dikenal. Ini mencegah bot spam di grup.

### Group Channel Cache

`groupService.js` menggunakan in-memory cache yang di-rebuild setiap kali ada perubahan channel. Cache ini otomatis konsisten — tidak perlu restart bot saat mengubah channel via `!group channel`.

---

## 📝 Template Plugin Siap Pakai

### Template Command Plugin (Minimal)

```js
// plugins/namaPlugin.js
import logger from '../utils/logger.js';

export default {
  name: 'namaPlugin',
  description: 'Deskripsi plugin',
  commands: ['cmd'],
  ownerOnly: false,

  handler: async ({ sock, msg, jid, sender, isOwner, text, command, args, fullArgs, reply, groupChannel }) => {
    try {
      if (!fullArgs) {
        await reply(`❓ Penggunaan: !${command} <argumen>`);
        return;
      }
      // logika...
      await reply('✅ Berhasil!');
    } catch (err) {
      logger.error({ command, err: err.message }, 'Error di plugin namaPlugin');
      await reply('⚠️ Terjadi kesalahan. Coba lagi nanti.');
    }
  },
};
```

### Template Command Plugin (dengan DB + Cron + Group Output)

```js
// plugins/namaPlugin.js
import db from '../services/db.js';
import { getGroupOutput } from '../services/groupService.js';
import logger from '../utils/logger.js';

let _sock = null;
const COLLECTION = 'namaCollection';
const PLUGIN_KEY = 'namaPlugin'; // key yang dipakai untuk !group channel

export default {
  name: 'namaPlugin',
  description: 'Deskripsi plugin dengan db, cron, dan group output',
  commands: ['cmd'],
  ownerOnly: false,

  crons: [
    {
      name: 'namaPlugin:namaJob',
      expr: '0 * * * *',  // setiap jam
      handler: async () => {
        if (!_sock) return;
        const items = db.find(COLLECTION, { status: 'pending' });

        for (const item of items) {
          const message = `📢 Update: ${item.data}`;

          // Kirim ke grup output
          const outputGroups = getGroupOutput(PLUGIN_KEY);
          for (const groupJid of outputGroups) {
            await _sock.sendMessage(groupJid, { text: message });
          }

          await db.update(COLLECTION, { _id: item._id }, { status: 'done' });
        }
        logger.info({ count: items.length }, '⚙️ Cron namaPlugin selesai');
      },
    },
  ],

  handler: async ({ sock, jid, command, args, fullArgs, reply, groupChannel }) => {
    _sock = sock; // simpan referensi untuk cron

    try {
      if (command === 'cmd') {
        const doc = await db.insert(COLLECTION, { data: fullArgs, status: 'pending' });
        await reply(`✅ Disimpan dengan ID: ${doc._id}`);
      }
    } catch (err) {
      logger.error({ command, err: err.message }, 'Error di plugin namaPlugin');
      await reply('⚠️ Terjadi kesalahan. Coba lagi nanti.');
    }
  },
};
```

### Template Triggered Plugin

```js
// plugins/triggered/namaIntent.js
import logger from '../../utils/logger.js';

export default {
  intent: 'namaIntent',
  intentDefinition: `"namaIntent" - deskripsi kapan intent ini aktif dan apa yang owner maksud. Ekstrak: param1 (tipe, keterangan), param2 (tipe, keterangan). Tambahkan kondisi khusus jika diperlukan.`,
  groupContextPrompt: `Teks persona domain yang relevan untuk grup yang ditautkan ke plugin ini. Tulis dalam satu baris tanpa newline. Contoh: "Kamu adalah asisten keuangan pribadi owner. Pahami semua transaksi, kategori pengeluaran, dan laporan yang disebutkan owner. Jawab ringkas dalam Bahasa Indonesia."`,

  name: 'Nama Plugin',           // opsional, untuk log
  description: 'Deskripsi',     // opsional
  ownerOnly: true,               // opsional

  handler: async ({ sock, jid, sender, text, params, reply, groupChannel }) => {
    const { param1, param2 } = params;

    if (!param1) {
      await reply('⚠️ Informasi tidak cukup. Sebutkan [param1] dengan lebih jelas.');
      return;
    }

    try {
      // logika...
      await reply(`✅ Berhasil menjalankan namaIntent.`);
    } catch (err) {
      logger.error({ intent: 'namaIntent', err: err.message }, 'Error di triggered plugin');
      await reply('⚠️ Gagal menjalankan aksi. Coba lagi atau cek log.');
    }
  },
};
```

---

## 3️⃣ Scheduled Plugin

### Cara Kerja

Scheduled plugin berjalan **otomatis berdasarkan jadwal** tanpa membutuhkan trigger dari pesan apapun. Plugin di-load oleh `scheduledPluginLoader.js` saat bot start, cron job didaftarkan ke `cronService`, dan dijalankan oleh `cronService.startAll()` setelah `connection.open`.

Plugin ini **tidak memiliki command handler** — tidak bisa dipanggil manual oleh user atau owner. Semua eksekusi dilakukan secara otomatis oleh scheduler.

Scheduled plugin dapat mengakses:
- **`aiService`** — untuk generate konten dari Qwen
- **`groupService`** — untuk mendapatkan JID grup tertaut sebagai output
- **`db`** — untuk menyimpan/membaca data
- **`global._sock`** — untuk mengirim pesan ke WhatsApp (di-expose oleh `bot.js` saat connection open)

> ℹ️ `global._sock` di-set saat `connection.open` dan di-clear saat `connection.close`. Scheduled plugin harus selalu guard dengan `global._sock?.sendMessage(...)` agar tidak error saat bot sedang reconnect.

### Struktur File

```js
// plugins/scheduled/namaPlugin.js
export default {
  name: 'Nama Plugin',           // wajib — untuk log dan debug
  description: 'Deskripsi singkat apa yang dilakukan plugin ini',  // wajib

  crons: [
    {
      name: 'scheduled:namaJob', // wajib, harus unik — gunakan prefix "scheduled:"
      expr: '@every_4h',         // wajib — cron expression atau alias
      handler: async () => { },  // wajib — fungsi yang dijalankan
      runOnStart: false,         // opsional — jalankan sekali saat bot start (default: false)
    },
  ],
};
```

### Alias Cron Expression yang Didukung

| Alias | Interval |
|---|---|
| `@every_<N>s` | Setiap N detik |
| `@every_<N>m` | Setiap N menit |
| `@every_<N>h` | Setiap N jam |
| `@hourly` | Setiap jam (= `0 * * * *`) |
| `@daily` | Setiap hari tengah malam |
| `@weekly` | Setiap minggu |
| `@monthly` | Setiap bulan |
| Standard 5-field | `*/5 * * * *`, `0 9 * * 1-5`, dll |

### Mengirim Pesan dari Scheduled Plugin

Karena handler cron tidak menerima `sock` sebagai parameter, gunakan `global._sock` yang di-expose oleh `bot.js`:

```js
// Kirim ke grup tertaut
const targetGroups = getGroupOutput('namaPluginKey');
for (const groupJid of targetGroups) {
  await global._sock?.sendMessage(groupJid, { text: content });
}

// Fallback ke owner jika tidak ada grup tertaut
if (targetGroups.length === 0) {
  const ownerJid = config.ownerLid || config.ownerJid;
  await global._sock?.sendMessage(ownerJid, { text: content });
}
```

### Menggunakan AI (Qwen) di Scheduled Plugin

Gunakan `askAI` dengan `jid` unik yang tidak bentrok dengan session chat owner atau grup:

```js
import { askAI } from '../../services/aiService.js';

const content = await askAI({
  jid: 'scheduled:namaJob',   // key unik untuk session AI plugin ini
  userText: 'Prompt ke Qwen',
  systemPrompt: 'Peran dan instruksi Qwen untuk plugin ini',
});
```

> ℹ️ Gunakan `jid` yang konsisten dan unik per scheduled plugin (misal `scheduled:economicNews`) agar session AI plugin tidak bercampur dengan session chat owner atau grup.

### Contoh: Plugin News Ekonomi

```js
// plugins/scheduled/economicNews.js
import { askAI } from '../../services/aiService.js';
import { getGroupOutput } from '../../services/groupService.js';
import config from '../../config/config.js';
import logger from '../../utils/logger.js';

const NEWS_PROMPT = `Kamu adalah analis ekonomi. Berikan ringkasan berita ekonomi global dan Indonesia yang paling relevan saat ini dalam format ringkas untuk WhatsApp. Maksimal 300 kata.`;

async function sendEconomicNews() {
  logger.info('📰 Menjalankan scheduled economic news...');

  const newsContent = await askAI({
    jid: 'scheduled:economicNews',
    userText: 'Berikan update berita ekonomi sekarang.',
    systemPrompt: NEWS_PROMPT,
  });

  if (!newsContent) return;

  const targetGroups = getGroupOutput('economicNews');

  if (targetGroups.length > 0) {
    for (const groupJid of targetGroups) {
      await global._sock?.sendMessage(groupJid, { text: newsContent });
    }
  } else {
    const ownerJid = config.ownerLid || config.ownerJid;
    await global._sock?.sendMessage(ownerJid, { text: newsContent });
  }
}

export default {
  name: 'Economic News',
  description: 'Kirim ringkasan berita ekonomi global dan Indonesia setiap 4 jam',

  crons: [
    {
      name: 'scheduled:economicNews',
      expr: '@every_4h',
      handler: sendEconomicNews,
      runOnStart: false,
    },
  ],
};
```

### Menautkan Scheduled Plugin ke Grup

Scheduled plugin menggunakan sistem group channel yang sama dengan plugin lain:

```
!group channel <groupJid> economicNews output
```

Plugin kemudian memanggil `getGroupOutput('economicNews')` untuk mendapat daftar grup tujuan. Jika tidak ada grup tertaut, plugin fallback ke DM owner.

### Checklist Scheduled Plugin

- [ ] File ada di `/plugins/scheduled/`
- [ ] Nama file tidak diawali `_`
- [ ] Export default memiliki field `name`, `description`, dan `crons[]`
- [ ] Setiap cron job memiliki `name` unik dengan prefix `scheduled:`
- [ ] `expr` menggunakan alias atau cron expression yang valid
- [ ] Handler menggunakan `global._sock?.sendMessage(...)` (bukan `sock.sendMessage`)
- [ ] Jika menggunakan AI: `jid` untuk `askAI` unik dan konsisten (misal `scheduled:namaJob`)
- [ ] Jika ada grup tertaut: gunakan `getGroupOutput('pluginKey')` dengan fallback ke owner

### Template Scheduled Plugin

```js
// plugins/scheduled/namaPlugin.js
import { askAI } from '../../services/aiService.js';
import { getGroupOutput } from '../../services/groupService.js';
import config from '../../config/config.js';
import logger from '../../utils/logger.js';

const SYSTEM_PROMPT = `Peran dan instruksi Qwen untuk plugin ini.`;

async function runJob() {
  logger.info('⏰ Menjalankan scheduled:namaJob...');

  // 1. Generate konten dari AI (opsional)
  let content;
  try {
    content = await askAI({
      jid: 'scheduled:namaJob',
      userText: 'Prompt ke Qwen',
      systemPrompt: SYSTEM_PROMPT,
    });
  } catch (err) {
    logger.error({ err: err.message }, '❌ Gagal generate konten dari AI');
    return;
  }

  if (!content) return;

  // 2. Kirim ke grup tertaut atau fallback ke owner
  const targetGroups = getGroupOutput('namaPluginKey');

  if (targetGroups.length > 0) {
    for (const groupJid of targetGroups) {
      try {
        await global._sock?.sendMessage(groupJid, { text: content });
        logger.info({ groupJid }, '✅ Pesan terkirim ke grup');
      } catch (err) {
        logger.error({ groupJid, err: err.message }, '❌ Gagal kirim ke grup');
      }
    }
  } else {
    const ownerJid = config.ownerLid || config.ownerJid;
    if (ownerJid) {
      await global._sock?.sendMessage(ownerJid, { text: content });
      logger.info('✅ Pesan terkirim ke owner (fallback)');
    }
  }
}

export default {
  name: 'Nama Plugin',
  description: 'Deskripsi singkat plugin ini',

  crons: [
    {
      name: 'scheduled:namaJob',
      expr: '@every_4h',        // ganti sesuai kebutuhan
      handler: runJob,
      runOnStart: false,
    },
  ],
};
```

---

## 🗂️ Ringkasan Cepat

```
Mau buat command plugin (!namaCmd)?
  → Buat file di /plugins/namaPlugin.js
  → Export default { name, description, commands, ownerOnly, handler }
  → Restart bot

Mau buat triggered plugin (via intent)?
  → Buat file di /plugins/triggered/namaIntent.js
  → Export default { intent, intentDefinition, groupContextPrompt, handler }
  → intentDefinition otomatis di-inject ke system prompt Qwen — tidak perlu edit file core
  → groupContextPrompt otomatis jadi persona grup saat plugin di-assign sebagai input/both
  → Restart bot

Mau buat scheduled plugin (berjalan otomatis)?
  → Buat file di /plugins/scheduled/namaPlugin.js
  → Export default { name, description, crons: [{ name, expr, handler, runOnStart }] }
  → Gunakan global._sock?.sendMessage() untuk kirim pesan
  → Gunakan getGroupOutput('pluginKey') untuk dapat grup tertaut, fallback ke owner jika kosong
  → Restart bot

Mau tautkan triggered plugin ke grup?
  → !group channel <groupJid> <intentName> input/both
  → Persona grup otomatis diambil dari groupContextPrompt plugin (jika diisi)
  → Satu grup hanya boleh punya SATU plugin input — hapus dulu yang lama jika ingin ganti
  → Untuk hapus: !group channel <groupJid> <intentName> none

Mau tautkan scheduled plugin ke grup?
  → !group channel <groupJid> <pluginKey> output
  → Plugin otomatis kirim ke grup saat cron berjalan
  → Tanpa grup tertaut: plugin fallback kirim ke owner

Mau simpan data ke database?
  → import db from '../services/db.js'
  → await db.insert / db.find / db.update / db.delete

Mau jadwalkan tugas berkala?
  → Tambahkan field crons: [{ name, expr, handler }] ke export default plugin
  → pluginLoader otomatis mendaftarkan dan bot.js otomatis menjalankan saat connect

Mau kirim output ke grup?
  → import { getGroupOutput } from '../services/groupService.js'
  → const jids = getGroupOutput('pluginKey')
  → for (const jid of jids) await sock.sendMessage(jid, { text: '...' })
  → Owner set channel via: !group channel <groupJid> <pluginKey> output

Mau terima input dari grup?
  → Tidak perlu kode tambahan — messageHandler otomatis routing ke plugin
  → Owner set channel via: !group channel <groupJid> <pluginKey> input
  → ctx.groupChannel tersedia di handler jika pesan dari grup

Mau daftarkan grup baru?
  → Masuk ke grup → ketik: !group register
  → Bot otomatis detect JID dan nama grup
  → Set channel: !group channel <groupJid> <pluginKey> <role>
```