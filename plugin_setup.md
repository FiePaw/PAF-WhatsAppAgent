# 🧩 PLUGIN SETUP GUIDE — WhatsApp AI Bot (PAF)

Panduan lengkap membuat plugin untuk bot WhatsApp ini: **Command Plugin**, **Triggered Plugin**, serta penggunaan **Database (db)** dan **Cron Scheduler (cronService)** di dalam plugin.

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
│
└── triggered/           ← Triggered plugin (via intent detection)
    └── sendMessage.js
```

Ada **dua jenis plugin**:

| Jenis | Cara Aktif | Lokasi |
|---|---|---|
| **Command Plugin** | User ketik `!namaCommand` | `/plugins/*.js` |
| **Triggered Plugin** | AI mendeteksi intent dari percakapan | `/plugins/triggered/*.js` |

Kedua jenis plugin dapat menggunakan **database JSON** dan **cron scheduler** secara opsional.

---

## 1️⃣ Command Plugin

### Cara Kerja

1. User mengirim pesan diawali prefix (default: `!`), contoh: `!ping`
2. `messageHandler.js` mendeteksi bahwa pesan adalah command
3. `pluginLoader.js` mencari plugin yang memiliki command `ping` di `Map`
4. Handler plugin dipanggil dengan `ctx` (context object)

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

> ⚠️ **Catatan:** Pengecekan `ownerOnly` dilakukan otomatis oleh `messageHandler.js` **sebelum** handler dipanggil. Kamu tidak perlu cek ulang di dalam handler.

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

1. Owner mengirim pesan **tanpa prefix** (bukan command)
2. `messageHandler.js` menjalankan **dua proses paralel**:
   - Intent detection via `intentSessionService.js` (kirim ke Qwen)
   - AI chat biasa via `aiService.js`
3. Jika Qwen mendeteksi intent (return JSON `{ intent: "...", params: {...} }`):
   - Triggered plugin yang sesuai dijalankan
   - Hasil AI chat **dibuang** (tidak dikirim)
4. Jika tidak ada intent → hasil AI chat dikirim ke owner

> ⚠️ **Triggered plugin hanya aktif untuk owner.** Non-owner hanya mendapat AI chat biasa.

### Struktur File

```js
// plugins/triggered/namaPlugin.js
export default {
  intent: 'namaIntent',   // harus cocok dengan intent yang dikembalikan Qwen (case-insensitive)

  handler: async (ctx) => {
    // logika triggered plugin di sini
  },
};
```

### Context Object Triggered Plugin (`ctx`)

Sama seperti command plugin, **ditambah satu property**:

| Property | Tipe | Keterangan |
|---|---|---|
| `params` | object | Parameter yang diekstrak Qwen dari percakapan |
| `sock` | object | Baileys socket |
| `msg` | object | Baileys message object |
| `jid` | string | JID chat asal pesan |
| `sender` | string | JID pengirim (owner) |
| `isOwner` | boolean | Selalu `true` untuk triggered plugin |
| `text` | string | Teks pesan asli dari owner |
| `reply` | async fn | Fungsi reply dengan typing delay |

### Mendaftarkan Intent Baru ke Qwen

Intent detector di `intentSessionService.js` menggunakan system prompt yang sudah terdefinisi. Untuk menambah intent baru, **edit `INTENT_SYSTEM_PROMPT`** di file tersebut:

```js
// Cari baris ini di services/intentSessionService.js
const INTENT_SYSTEM_PROMPT = `... [1] "sendMessage" - ...`;

// Tambahkan intent baru, contoh:
// ... [2] "setReminder" - owner ingin membuat pengingat.
//   Ekstrak: time (string, waktu dalam format HH:MM) dan message (string, isi pengingat).
```

Format penambahan intent di system prompt:

```
[N] "namaIntent" - deskripsi kapan intent ini aktif.
  Ekstrak: param1 (tipe, keterangan), param2 (tipe, keterangan).
  Kondisi khusus jika ada.
```

### Contoh: Triggered Plugin Sederhana

```js
// plugins/triggered/setReminder.js
export default {
  intent: 'setReminder',

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

  handler: async ({ params, sock, reply }) => {
    const { targetNumber, message } = params;

    if (!targetNumber || !message) {
      await reply('⚠️ Nomor tujuan atau pesan tidak terdeteksi dengan jelas.');
      return;
    }

    const targetJid = `${targetNumber}@s.whatsapp.net`;

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

## 3️⃣ Database JSON (`db`)

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
setGlobalPersona('default', '...');     // update persona global
listPersonas();                         // list semua persona
```

### `intentSessionService.js` — Kelola Intent Session

```js
import {
  listIntentSessions,
  deleteIntentSession,
} from '../services/intentSessionService.js';

listIntentSessions();            // list semua intent session aktif
deleteIntentSession(senderJid);  // hapus intent session (akan di-reinit otomatis)
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

### Triggered Plugin

- [ ] File ada di `/plugins/triggered/`
- [ ] Nama file tidak diawali `_`
- [ ] File menggunakan `export default { intent, handler }`
- [ ] `intent` cocok **persis** dengan intent yang ada di `INTENT_SYSTEM_PROMPT` (case-insensitive)
- [ ] Intent baru sudah didaftarkan di `INTENT_SYSTEM_PROMPT` dalam `intentSessionService.js`
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

---

## ⚠️ Hal-hal yang Perlu Diperhatikan

### Path Import

Sesuaikan path relatif berdasarkan lokasi file plugin:

```js
// Dari /plugins/namaPlugin.js
import { askAI } from '../services/aiService.js';
import db from '../services/db.js';
import cronService from '../services/cronService.js';
import config from '../config/config.js';
import logger from '../utils/logger.js';

// Dari /plugins/triggered/namaPlugin.js
import { askAI } from '../../services/aiService.js';
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

Pengecekan dilakukan **otomatis sebelum handler dipanggil**. Tidak perlu cek `isOwner` di dalam handler untuk keperluan ini. Tapi jika ada logika berbeda untuk owner vs non-owner:

```js
handler: async ({ isOwner, reply }) => {
  if (isOwner) {
    await reply('👑 Halo owner!');
  } else {
    await reply('👋 Halo user!');
  }
},
```

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

  handler: async ({ sock, msg, jid, sender, isOwner, text, command, args, fullArgs, reply }) => {
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

### Template Command Plugin (dengan DB + Cron)

```js
// plugins/namaPlugin.js
import db from '../services/db.js';
import logger from '../utils/logger.js';

let _sock = null;
const COLLECTION = 'namaCollection';

export default {
  name: 'namaPlugin',
  description: 'Deskripsi plugin dengan db dan cron',
  commands: ['cmd'],
  ownerOnly: false,

  crons: [
    {
      name: 'namaPlugin:namaJob',
      expr: '0 * * * *',  // setiap jam
      handler: async () => {
        const items = db.find(COLLECTION, { status: 'pending' });
        for (const item of items) {
          // proses item...
          await db.update(COLLECTION, { _id: item._id }, { status: 'done' });
        }
        logger.info({ count: items.length }, '⚙️ Cron namaPlugin selesai');
      },
    },
  ],

  handler: async ({ sock, jid, command, args, fullArgs, reply }) => {
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

  handler: async ({ sock, jid, sender, text, params, reply }) => {
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

## 🗂️ Ringkasan Cepat

```
Mau buat command plugin (!namaCmd)?
  → Buat file di /plugins/namaPlugin.js
  → Export default { name, description, commands, ownerOnly, handler }
  → Restart bot

Mau buat triggered plugin (via intent)?
  → Daftarkan intent baru di INTENT_SYSTEM_PROMPT (intentSessionService.js)
  → Buat file di /plugins/triggered/namaIntent.js
  → Export default { intent, handler }
  → Restart bot

Mau simpan data ke database?
  → import db from '../services/db.js'
  → await db.insert / db.find / db.update / db.delete

Mau jadwalkan tugas berkala?
  → Tambahkan field crons: [{ name, expr, handler }] ke export default plugin
  → pluginLoader otomatis mendaftarkan dan bot.js otomatis menjalankan saat connect
```