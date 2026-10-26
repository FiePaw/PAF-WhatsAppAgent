// plugins/triggered/myFinance.js
// Intent keuangan pribadi via FinTrack (v6.8.0: edit data, laporan berperiode, input banyak
// sekaligus, pengingat otomatis [plugins/scheduled/finReminder.js], baca struk).
import logger from '../../utils/logger.js';
import { ft, FinTrackError, list, create, update } from '../../services/finTrackClient.js';
import { formatRp, resolvePeriod, buildReport } from '../../services/finTrackReport.js';
import { extractReceipt } from '../../services/finTrackReceipt.js';
import { setPending } from '../../services/calendarPending.js';
import { todayStr, isValidDate } from '../../services/calendarFormat.js';

// ─── HELPER ──────────────────────────────────────────────────────────────────
// Koneksi & kredensial FinTrack ada di services/finTrackClient.js
// (env FINTRACK_API_URL / FINTRACK_API_KEY, default = nilai lama).

// Tanggal hari ini dalam WIB (sebelumnya UTC → salah tanggal pada 00:00–07:00 WIB).
function todayDate() {
  return todayStr();
}

// ─── PENDING CONFIRMATIONS (in-memory) ───────────────────────────────────────
// key: senderJid → { mode: 'delete'|'update', endpoint?, resource?, patch?, candidates: [{id, label, current?}], expiresAt }
const pendingConfirm = new Map();

// ─── KONFIGURASI PER RESOURCE (dipakai fitur ubah data) ──────────────────────
const has = (s, k) => String(s || '').toLowerCase().includes(k);
const RES = {
  transactions: {
    label: 'Transaksi',
    match: (x, k) => has(x.description, k) || has(x.category, k),
    describe: (x) => `${formatRp(x.amount)} [${x.category}] — ${x.description || '-'} (${x.date})`,
    fields: { type: 'Jenis', amount: 'Nominal', category: 'Kategori', date: 'Tanggal', description: 'Keterangan' },
    fmt: { amount: formatRp, type: (v) => (v === 'income' ? 'Pemasukan' : 'Pengeluaran') },
  },
  bills: {
    label: 'Tagihan',
    match: (x, k) => has(x.name, k) || has(x.category, k),
    describe: (x) => `${x.name} — ${formatRp(x.amount)} (tgl ${x.due_day})`,
    fields: { name: 'Nama', amount: 'Nominal', due_day: 'Jatuh tempo (tgl)', category: 'Kategori', autodebit: 'Auto-debit', notes: 'Catatan' },
    fmt: { amount: formatRp, autodebit: (v) => (v ? 'Ya' : 'Tidak') },
  },
  investments: {
    label: 'Saham',
    match: (x, k) => has(x.code, k) || has(x.name, k),
    describe: (x) => `${x.code} — ${x.name} (${x.shares} lbr @ ${formatRp(x.buy_price)})`,
    fields: { name: 'Nama', shares: 'Jumlah lembar', buy_price: 'Harga beli', buy_date: 'Tanggal beli', notes: 'Catatan' },
    fmt: { buy_price: formatRp },
  },
};

// ─── UBAH DATA ───────────────────────────────────────────────────────────────
/** Bangun patch dari params intent; kembalikan { patch, errors }. */
function buildPatch(resource, p) {
  const patch = {};
  const errors = [];
  const positive = (v, label) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) { errors.push(`${label} harus angka lebih dari 0.`); return undefined; }
    return n;
  };
  const given = (v) => v !== undefined && v !== null && v !== '';

  if (resource === 'transactions') {
    if (given(p.type)) { if (p.type === 'income' || p.type === 'expense') patch.type = p.type; else errors.push('Jenis harus pemasukan atau pengeluaran.'); }
    if (given(p.amount)) { const n = positive(p.amount, 'Nominal'); if (n !== undefined) patch.amount = n; }
    if (given(p.category)) patch.category = String(p.category).trim();
    if (given(p.date)) { if (isValidDate(p.date)) patch.date = p.date; else errors.push('Tanggal harus format YYYY-MM-DD yang valid.'); }
    if (p.description !== undefined && p.description !== null) patch.description = String(p.description).trim();
  } else if (resource === 'bills') {
    if (given(p.newName)) patch.name = String(p.newName).trim();
    if (given(p.amount)) { const n = positive(p.amount, 'Nominal'); if (n !== undefined) patch.amount = n; }
    if (given(p.due_day)) { const n = Number(p.due_day); if (Number.isInteger(n) && n >= 1 && n <= 31) patch.due_day = n; else errors.push('Tanggal jatuh tempo harus 1–31.'); }
    if (given(p.category)) patch.category = String(p.category).trim();
    if (typeof p.autodebit === 'boolean') patch.autodebit = p.autodebit;
    if (p.notes !== undefined && p.notes !== null) patch.notes = String(p.notes);
  } else if (resource === 'investments') {
    if (given(p.stockName)) patch.name = String(p.stockName).trim();
    if (given(p.shares)) { const n = positive(p.shares, 'Jumlah lembar'); if (n !== undefined) patch.shares = n; }
    if (given(p.buy_price)) { const n = positive(p.buy_price, 'Harga beli'); if (n !== undefined) patch.buy_price = n; }
    if (given(p.buy_date)) { if (isValidDate(p.buy_date)) patch.buy_date = p.buy_date; else errors.push('Tanggal beli harus format YYYY-MM-DD yang valid.'); }
    if (p.notes !== undefined && p.notes !== null) patch.notes = String(p.notes);
  }
  return { patch, errors };
}

/** Cari data target. Transaksi tanpa kata kunci = transaksi terbaru ("yang tadi"). */
async function findTargets(resource, keyword) {
  const all = await list(resource);
  const arr = Array.isArray(all) ? all : [];
  const k = String(keyword || '').trim().toLowerCase();
  if (!k) {
    if (resource !== 'transactions' || !arr.length) return [];
    // tanggal terbaru; jika sama, yang paling akhir di daftar
    return [arr.reduce((best, t) => (!best || String(t.date || '') >= String(best.date || '') ? t : best), null)];
  }
  return arr.filter((x) => RES[resource].match(x, k));
}

/** Tampilkan perubahan (sebelum → sesudah) dan minta konfirmasi !ya / !tidak. */
async function askConfirmUpdate({ sender, reply, resource, target, patch }) {
  const cfg = RES[resource];
  const lines = [];
  for (const [k, v] of Object.entries(patch)) {
    if (String(target[k]) === String(v)) continue;
    const f = cfg.fmt[k] || ((x) => x);
    const before = target[k] === undefined || target[k] === null || target[k] === '' ? '-' : f(target[k]);
    lines.push(`• ${cfg.fields[k] || k}: ${before} → *${f(v)}*`);
  }
  if (!lines.length) {
    await reply('ℹ️ Tidak ada perubahan — nilai barunya sama dengan data sekarang.');
    return;
  }

  setPending(sender, {
    kind: 'finance',
    run: async (say) => {
      const { data } = await update(resource, target, patch);
      const merged = { ...target, ...patch, ...(data && typeof data === 'object' && !Array.isArray(data) ? data : {}) };
      await say(`✅ ${cfg.label} diperbarui:\n${cfg.describe(merged)}`);
    },
  });
  await reply(
    `✏️ Ubah ${cfg.label.toLowerCase()}:\n${cfg.describe(target)}\n\n${lines.join('\n')}\n\n` +
    'Simpan? Balas *!ya* atau *!tidak* (berlaku 5 menit).'
  );
}

async function doUpdate({ resource, params, sender, reply }) {
  const cfg = RES[resource];
  const { patch, errors } = buildPatch(resource, params);
  if (errors.length) { await reply(`⚠️ ${errors.join('\n⚠️ ')}`); return; }
  if (!Object.keys(patch).length) {
    await reply('⚠️ Mau diubah jadi apa? Sebutkan nilai barunya, misal: "ubah pengeluaran kopi jadi 25rb".');
    return;
  }
  if (!params.searchKeyword && resource !== 'transactions') {
    await reply(`⚠️ Sebutkan ${cfg.label.toLowerCase()} mana yang ingin diubah.`);
    return;
  }

  const matches = await findTargets(resource, params.searchKeyword);
  if (!matches.length) {
    await reply(params.searchKeyword
      ? `❌ Tidak ada ${cfg.label.toLowerCase()} yang cocok dengan "*${params.searchKeyword}*".`
      : `❌ Belum ada ${cfg.label.toLowerCase()} yang bisa diubah.`);
    return;
  }
  if (matches.length === 1) {
    await askConfirmUpdate({ sender, reply, resource, target: matches[0], patch });
    return;
  }

  const shown = matches.slice(0, 10);
  pendingConfirm.set(sender, {
    mode: 'update',
    resource,
    patch,
    candidates: shown.map((x) => ({ id: x.id, label: cfg.describe(x), current: x })),
    expiresAt: Date.now() + 2 * 60 * 1000,
  });
  let msg = `🔍 Ditemukan *${matches.length}* ${cfg.label.toLowerCase()} cocok${matches.length > shown.length ? ` (menampilkan ${shown.length} pertama — sebut lebih spesifik jika tidak ada)` : ''}. Pilih yang mau diubah?\n\n`;
  shown.forEach((x, i) => { msg += `*${i + 1}.* ${cfg.describe(x)}\n`; });
  msg += '\nBalas dengan angka pilihanmu (berlaku 2 menit).';
  await reply(msg);
}

// ─── CATAT BANYAK TRANSAKSI SEKALIGUS ────────────────────────────────────────
async function doAddTransactions({ items, sender, reply }) {
  const arr = Array.isArray(items) ? items : [];
  if (!arr.length) {
    await reply('⚠️ Sebutkan transaksinya. Contoh: "kopi 20rb, makan siang 35rb, parkir 5rb".');
    return;
  }
  if (arr.length > 20) { await reply('⚠️ Maksimal 20 transaksi sekaligus.'); return; }

  const today = todayDate();
  const valid = [];
  const problems = [];
  arr.forEach((it, i) => {
    const issues = [];
    const type = it?.type === 'income' ? 'income' : it?.type === 'expense' ? 'expense' : null;
    const amount = Number(it?.amount);
    const category = typeof it?.category === 'string' ? it.category.trim() : '';
    const date = it?.date ? String(it.date) : today;
    if (!type) issues.push('jenis (pemasukan/pengeluaran) tidak jelas');
    if (!Number.isFinite(amount) || amount <= 0) issues.push('nominal tidak valid');
    if (!category) issues.push('kategori kosong');
    if (!isValidDate(date)) issues.push('tanggal tidak valid');
    if (issues.length) problems.push(`#${i + 1}: ${issues.join(', ')}`);
    else valid.push({ type, amount, category, date, description: typeof it.description === 'string' ? it.description.trim() : '' });
  });
  if (problems.length) {
    await reply(`⚠️ Ada data yang kurang/tidak valid — tidak ada yang disimpan:\n${problems.join('\n')}\n\nCoba sebutkan lagi lebih lengkap.`);
    return;
  }

  const line = (t) => `${t.type === 'income' ? '➕' : '➖'} ${formatRp(t.amount)} [${t.category}]${t.description ? ` — ${t.description}` : ''} (${t.date})`;
  const totalIn = valid.filter((t) => t.type === 'income').reduce((s, t) => s + t.amount, 0);
  const totalOut = valid.filter((t) => t.type === 'expense').reduce((s, t) => s + t.amount, 0);

  setPending(sender, {
    kind: 'finance',
    run: async (say) => {
      let ok = 0;
      const failed = [];
      for (let i = 0; i < valid.length; i += 1) {
        try { await create('transactions', valid[i]); ok += 1; } catch (err) {
          failed.push(`${line(valid[i])} — ${err.message}`);
          if (err instanceof FinTrackError && err.status === 0) {
            valid.slice(i + 1).forEach((t) => failed.push(`${line(t)} — tidak dikirim (FinTrack tidak terhubung)`));
            break;
          }
        }
      }
      await say(`✅ ${ok}/${valid.length} transaksi tercatat.${failed.length ? `\n⚠️ Gagal:\n${failed.join('\n')}` : ''}`);
    },
  });
  await reply(
    `📝 Catat ${valid.length} transaksi:\n${valid.map((t, i) => `${i + 1}. ${line(t)}`).join('\n')}\n\n` +
    `${totalOut ? `💸 Total pengeluaran: ${formatRp(totalOut)}\n` : ''}${totalIn ? `💰 Total pemasukan: ${formatRp(totalIn)}\n` : ''}` +
    '\nSimpan semua? Balas *!ya* atau *!tidak* (berlaku 5 menit).'
  );
}

// ─── BACA STRUK DARI FOTO ────────────────────────────────────────────────────
async function doScanReceipt({ attachments, text, sender, reply }) {
  const images = (attachments || []).filter((a) => String(a?.mime_type || '').startsWith('image/'));
  if (!images.length) {
    await reply('📷 Kirim foto struk/bukti transfer bersama pesannya, nanti saya baca dan catat.');
    return;
  }

  let categories = [];
  try {
    const tx = await list('transactions').catch(() => []);
    categories = [...new Set((tx || []).map((x) => x.category).filter(Boolean))].slice(0, 30);
  } catch { /* kategori hanya pelengkap */ }

  const caption = String(text || '').replace(/\[gambar dikirim\]/g, '').trim();
  const r = await extractReceipt({ jid: sender, attachments: images, caption, categories, today: todayDate() });
  if (!r) {
    await reply('❌ Tidak bisa membaca nominal dari gambar itu. Coba foto yang lebih jelas, atau catat manual: "catat pengeluaran 25000 buat makan".');
    return;
  }

  const tx = { type: r.type, amount: r.amount, category: r.category, date: r.date, description: r.description };
  setPending(sender, {
    kind: 'finance',
    run: async (say) => {
      const saved = await create('transactions', tx);
      await say(`✅ Tercatat: ${formatRp(saved?.amount ?? tx.amount)} [${saved?.category ?? tx.category}] (${saved?.date ?? tx.date})`);
    },
  });
  await reply(
    `🧾 Hasil baca gambar:\n${tx.type === 'income' ? '💚 Pemasukan' : '🔴 Pengeluaran'}\n💰 ${formatRp(tx.amount)}\n📂 ${tx.category}\n📅 ${tx.date}` +
    `${tx.description ? `\n📝 ${tx.description}` : ''}\n\nSudah benar? Balas *!ya* untuk menyimpan atau *!tidak* untuk batal (berlaku 5 menit).\n` +
    '_Nominal/kategori salah? Balas !tidak lalu catat manual._'
  );
}


export default {
  intent: 'myFinance',

  intentDefinition: `"myFinance" - owner ingin mengelola keuangan pribadi via FinTrack. Pilih SATU action: addTransaction (catat SATU transaksi), addTransactions (catat BEBERAPA transaksi sekaligus dari satu pesan, isi items), addBill/addInvestment (tambah tagihan rutin/saham), updateTransaction/updateBill/updateInvestment (UBAH data yang sudah ada, mis. "ubah kopi tadi jadi 25rb", "ubah tagihan wifi jadi 350rb"; searchKeyword = data yang dimaksud, field lain = nilai baru), deleteTransaction/deleteBill/deleteInvestment (hapus), getSummary (laporan/ringkasan keuangan; isi period: today, yesterday, this_week, last_week, last_7_days, this_month, last_month, this_year, atau custom dengan date_from/date_to; kosongkan = bulan ini), scanReceipt (owner mengirim FOTO struk/bukti transfer/bukti belanja untuk dicatat), confirmDelete (owner menyebut angka/nomor sebagai pilihan dari daftar hasil pencarian hapus ATAU ubah sebelumnya — lihat riwayat percakapan).`,

  // ─── Parameters (JSON Schema, format function-calling §9 API_USAGE.md) ─
  // Catatan: hanya `action` yang wajib di level schema — field lain OPSIONAL
  // di sini karena kebutuhannya berbeda per action (mis. addBill butuh
  // due_day, addInvestment butuh shares/buy_price). Validasi field wajib
  // per-action tetap dilakukan di handler() seperti sebelumnya.
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: [
          'addTransaction', 'addTransactions', 'updateTransaction', 'deleteTransaction',
          'addBill', 'updateBill', 'deleteBill',
          'addInvestment', 'updateInvestment', 'deleteInvestment',
          'getSummary', 'scanReceipt', 'confirmDelete',
        ],
        description: 'Jenis operasi keuangan yang diminta owner',
      },
      type: { type: 'string', enum: ['income', 'expense'], description: 'Untuk addTransaction; juga nilai baru jenis transaksi untuk updateTransaction' },
      amount: { type: 'number', description: 'Nominal dalam Rupiah — untuk addTransaction, addBill, addInvestment (harga beli per lembar); pada update* = nominal BARU' },
      category: { type: 'string', description: 'Kategori transaksi/tagihan; pada updateTransaction/updateBill = kategori BARU; pada getSummary = filter kategori (opsional)' },
      date: { type: 'string', description: 'Format YYYY-MM-DD, kosongkan jika tidak disebut; pada updateTransaction = tanggal BARU' },
      description: { type: 'string', description: 'Keterangan transaksi — untuk addTransaction; pada updateTransaction = keterangan BARU' },
      searchKeyword: { type: 'string', description: 'Kata kunci nama/deskripsi untuk mencari item — untuk delete* dan update*. Untuk updateTransaction kosongkan jika owner bilang "yang tadi/terakhir"' },
      confirmIndex: { type: 'integer', description: 'Angka pilihan yang dipilih owner saat konfirmasi hapus/ubah — untuk confirmDelete' },
      name: { type: 'string', description: 'Nama tagihan — untuk addBill' },
      newName: { type: 'string', description: 'Nama BARU saat rename — untuk updateBill (nama)' },
      due_day: { type: 'integer', minimum: 1, maximum: 31, description: 'Tanggal jatuh tempo 1-31 — untuk addBill, updateBill' },
      autodebit: { type: 'boolean', description: 'Apakah auto-debit — untuk addBill, updateBill' },
      notes: { type: 'string', description: 'Catatan — untuk addBill, addInvestment, updateBill, updateInvestment' },
      code: { type: 'string', description: 'Kode saham IDX huruf kapital — untuk addInvestment' },
      stockName: { type: 'string', description: 'Nama perusahaan saham — untuk addInvestment; pada updateInvestment = nama BARU' },
      shares: { type: 'number', description: 'Jumlah lembar saham — untuk addInvestment, updateInvestment' },
      buy_price: { type: 'number', description: 'Harga beli per lembar — untuk addInvestment, updateInvestment' },
      buy_date: { type: 'string', description: 'Tanggal beli YYYY-MM-DD — untuk addInvestment, updateInvestment' },
      period: {
        type: 'string',
        enum: ['today', 'yesterday', 'this_week', 'last_week', 'last_7_days', 'this_month', 'last_month', 'this_year', 'custom'],
        description: 'Periode laporan — hanya untuk getSummary. Kosongkan = this_month',
      },
      date_from: { type: 'string', description: 'Awal periode YYYY-MM-DD — hanya untuk getSummary dengan period=custom' },
      date_to: { type: 'string', description: 'Akhir periode YYYY-MM-DD — hanya untuk getSummary dengan period=custom' },
      items: {
        type: 'array',
        maxItems: 20,
        description: 'Daftar transaksi — hanya untuk addTransactions (beberapa transaksi dalam satu pesan)',
        items: {
          type: 'object',
          properties: {
            type: { type: 'string', enum: ['income', 'expense'] },
            amount: { type: 'number', description: 'Nominal Rupiah' },
            category: { type: 'string' },
            date: { type: 'string', description: 'YYYY-MM-DD, kosongkan jika tidak disebut' },
            description: { type: 'string' },
          },
          required: ['type', 'amount', 'category'],
        },
      },
    },
    required: ['action'],
  },

  groupContextPrompt: `Kamu adalah asisten keuangan pribadi owner. Kamu memahami semua data keuangan owner: transaksi pemasukan dan pengeluaran, anggaran per kategori, tagihan rutin bulanan, dan portofolio investasi saham IDX. Bantu owner mencatat, mengelola, dan memahami kondisi keuangannya. Jawab ringkas dan pakai Bahasa Indonesia. Saat owner menyebut nominal uang, asumsikan dalam Rupiah.`,

  name: 'MyFinance',
  description: 'Manajemen keuangan pribadi via FinTrack API',
  ownerOnly: true,

  handler: async ({ params, sender, reply, attachments, text }) => {
    const { action } = params;

    // [Fix myFinance "params: {}"] Guard eksplisit untuk kasus action
    // hilang sama sekali (bukan sekadar di luar enum) — bisa terjadi jika
    // model mengembalikan SEBAGIAN params (mis. cuma { amount: 20000 })
    // tanpa field `action`. triggeredPluginHandler.js sudah menyaring kasus
    // params BENAR-BENAR kosong {} (fallback ke AI chat), tapi kasus ini
    // (params ada isinya tapi action-nya sendiri kosong) baru ketahuan di
    // sini — beri pesan yang lebih actionable daripada "Aksi tidak dikenali"
    // generik, dan log params mentah untuk diagnosa.
    if (!action) {
      logger.warn({ intent: 'myFinance', params }, '⚠️ myFinance: dipanggil tanpa field action sama sekali');
      await reply(
        '⚠️ Tidak bisa mendeteksi jenis aksi keuangan dari pesanmu.\n' +
        'Coba lebih spesifik, misal:\n' +
        '• "catat pengeluaran 20000 buat kopi"\n' +
        '• "lihat laporan keuangan bulan ini"\n' +
        '• "tambah anggaran makan 500rb"'
      );
      return;
    }

    try {
      // ── confirmDelete ──────────────────────────────────────────────────────
      if (action === 'confirmDelete') {
        const pending = pendingConfirm.get(sender);
        if (!pending || Date.now() > pending.expiresAt) {
          pendingConfirm.delete(sender);
          await reply('⏰ Tidak ada konfirmasi (hapus/ubah) yang aktif atau sudah kedaluwarsa.');
          return;
        }

        const idx = Number(params.confirmIndex) - 1;
        if (isNaN(idx) || idx < 0 || idx >= pending.candidates.length) {
          await reply(`❓ Pilihan tidak valid. Ketik angka 1–${pending.candidates.length}.`);
          return;
        }

        const target = pending.candidates[idx];
        pendingConfirm.delete(sender);

        if (pending.mode === 'update') {
          await askConfirmUpdate({ sender, reply, resource: pending.resource, target: target.current, patch: pending.patch });
          return;
        }

        await ft('DELETE', `${pending.endpoint}/${target.id}`);
        await reply(`🗑️ Berhasil dihapus:\n*${target.label}*`);
        return;
      }

      // ── getSummary ─────────────────────────────────────────────────────────
      // Laporan berperiode (hari ini … tahun ini / custom) — logika di services/finTrackReport.js
      if (action === 'getSummary') {
        const summary = await ft('GET', '/ext/summary');
        logger.info({ summaryKeys: Object.keys(summary || {}), period: params.period }, '📦 myFinance: summary response keys');

        const arr = (v) => (Array.isArray(v) ? v : []);
        const data = {
          transactions: arr(summary?.transactions),
          budgets: arr(summary?.budgets),
          bills: arr(summary?.bills),
          investments: arr(summary?.investments),
        };
        const period = resolvePeriod(params, todayDate());
        await reply(buildReport(data, period, { category: params.category, today: todayDate() }));
        return;
      }

      // ── addTransaction ─────────────────────────────────────────────────────
      if (action === 'addTransaction') {
        const { type, amount, category, date, description } = params;

        if (!type || !amount || !category) {
          await reply('⚠️ Kurang info. Sebutkan: jenis (pemasukan/pengeluaran), jumlah, dan kategori.');
          return;
        }

        const tx = await ft('POST', '/ext/transactions', {
          type,
          amount: Number(amount),
          category,
          date: date || todayDate(),
          description: description || '',
        });

        const icon = type === 'income' ? '💚 Pemasukan' : '🔴 Pengeluaran';
        await reply(
          `✅ *${icon} dicatat!*\n` +
          `💰 ${formatRp(tx.amount)}\n` +
          `📂 ${tx.category}\n` +
          `📅 ${tx.date}` +
          (tx.description ? `\n📝 ${tx.description}` : '')
        );
        return;
      }

      // ── deleteTransaction ──────────────────────────────────────────────────
      if (action === 'deleteTransaction') {
        const { searchKeyword } = params;
        if (!searchKeyword) {
          await reply('⚠️ Sebutkan transaksi mana yang ingin dihapus (deskripsi atau kategori).');
          return;
        }

        const transactions = await ft('GET', '/ext/transactions');
        const keyword = searchKeyword.toLowerCase();
        const matches = transactions.filter(t =>
          t.description?.toLowerCase().includes(keyword) ||
          t.category?.toLowerCase().includes(keyword)
        );

        if (matches.length === 0) {
          await reply(`❌ Tidak ada transaksi yang cocok dengan kata kunci "*${searchKeyword}*".`);
          return;
        }

        if (matches.length === 1) {
          await ft('DELETE', `/ext/transactions/${matches[0].id}`);
          const t = matches[0];
          await reply(
            `🗑️ Transaksi dihapus:\n` +
            `${formatRp(t.amount)} [${t.category}] — ${t.description || '-'} (${t.date})`
          );
          return;
        }

        // Lebih dari 1 — minta konfirmasi
        pendingConfirm.set(sender, {
          endpoint: '/ext/transactions',
          candidates: matches.map(t => ({
            id: t.id,
            label: `${formatRp(t.amount)} [${t.category}] — ${t.description || '-'} (${t.date})`,
          })),
          expiresAt: Date.now() + 2 * 60 * 1000, // 2 menit
        });

        let msg = `🔍 Ditemukan *${matches.length}* transaksi cocok. Pilih yang mana?\n\n`;
        matches.forEach((t, i) => {
          msg += `*${i + 1}.* ${formatRp(t.amount)} [${t.category}] — ${t.description || '-'} (${t.date})\n`;
        });
        msg += `\nBalas dengan angka pilihanmu (berlaku 2 menit).`;
        await reply(msg);
        return;
      }

      // ── addBudget / deleteBudget (Deprecated di FinTrack baru) ───────────
      if (action === 'addBudget' || action === 'deleteBudget' || action === 'updateBudget') {
        await reply('ℹ️ Fitur kelola anggaran (budgets) tidak lagi aktif di FinTrack versi saat ini. FinTrack sekarang menggunakan AI auto-categorization.');
        return;
      }

      // ── addBill ────────────────────────────────────────────────────────────
      if (action === 'addBill') {
        const { name, amount, due_day, category, autodebit, notes } = params;
        if (!name || !amount || !due_day || !category) {
          await reply('⚠️ Kurang info. Sebutkan: nama tagihan, nominal, tanggal jatuh tempo, dan kategori.');
          return;
        }

        const bill = await ft('POST', '/ext/bills', {
          name,
          amount: Number(amount),
          due_day: Number(due_day),
          category,
          autodebit: autodebit ?? false,
          notes: notes || '',
        });

        await reply(
          `✅ *Tagihan rutin ditambahkan!*\n` +
          `🧾 ${bill.name}\n` +
          `💰 ${formatRp(bill.amount)}/bln\n` +
          `📅 Jatuh tempo: tgl ${bill.due_day}\n` +
          `📂 ${bill.category}` +
          (bill.autodebit ? '\n🔄 Auto-debit aktif' : '')
        );
        return;
      }

      // ── deleteBill ─────────────────────────────────────────────────────────
      if (action === 'deleteBill') {
        const { searchKeyword } = params;
        if (!searchKeyword) {
          await reply('⚠️ Sebutkan nama tagihan yang ingin dihapus.');
          return;
        }

        const bills = await ft('GET', '/ext/bills');
        const keyword = searchKeyword.toLowerCase();
        const matches = bills.filter(b => b.name?.toLowerCase().includes(keyword));

        if (matches.length === 0) {
          await reply(`❌ Tidak ada tagihan bernama "*${searchKeyword}*".`);
          return;
        }

        if (matches.length === 1) {
          await ft('DELETE', `/ext/bills/${matches[0].id}`);
          await reply(`🗑️ Tagihan *${matches[0].name}* (${formatRp(matches[0].amount)}/bln) dihapus.`);
          return;
        }

        pendingConfirm.set(sender, {
          endpoint: '/ext/bills',
          candidates: matches.map(b => ({
            id: b.id,
            label: `${b.name} — ${formatRp(b.amount)}/bln (tgl ${b.due_day})`,
          })),
          expiresAt: Date.now() + 2 * 60 * 1000,
        });

        let msg = `🔍 Ditemukan *${matches.length}* tagihan. Pilih yang mana?\n\n`;
        matches.forEach((b, i) => {
          msg += `*${i + 1}.* ${b.name} — ${formatRp(b.amount)}/bln (tgl ${b.due_day})\n`;
        });
        msg += `\nBalas dengan angka pilihanmu (berlaku 2 menit).`;
        await reply(msg);
        return;
      }

      // ── addInvestment ──────────────────────────────────────────────────────
      if (action === 'addInvestment') {
        const { code, stockName, shares, buy_price, buy_date, notes } = params;
        if (!code || !stockName || !shares || !buy_price || !buy_date) {
          await reply('⚠️ Kurang info. Sebutkan: kode saham, nama perusahaan, jumlah lembar, harga beli per lembar, dan tanggal beli.');
          return;
        }

        const inv = await ft('POST', '/ext/investments', {
          code: String(code).toUpperCase(),
          name: stockName,
          shares: Number(shares),
          buy_price: Number(buy_price),
          buy_date,
          notes: notes || '',
        });

        const totalCost = inv.shares * inv.buy_price;
        await reply(
          `✅ *Saham ditambahkan ke portofolio!*\n` +
          `📈 ${inv.code} — ${inv.name}\n` +
          `📦 ${inv.shares} lembar @ ${formatRp(inv.buy_price)}\n` +
          `💰 Total modal: ${formatRp(totalCost)}\n` +
          `📅 Tanggal beli: ${inv.buy_date}`
        );
        return;
      }

      // ── deleteInvestment ───────────────────────────────────────────────────
      if (action === 'deleteInvestment') {
        const { searchKeyword } = params;
        if (!searchKeyword) {
          await reply('⚠️ Sebutkan kode saham atau nama perusahaan yang ingin dihapus.');
          return;
        }

        const investments = await ft('GET', '/ext/investments');
        const keyword = searchKeyword.toLowerCase();
        const matches = investments.filter(i =>
          i.code?.toLowerCase().includes(keyword) ||
          i.name?.toLowerCase().includes(keyword)
        );

        if (matches.length === 0) {
          await reply(`❌ Tidak ada saham cocok dengan "*${searchKeyword}*" di portofolio.`);
          return;
        }

        if (matches.length === 1) {
          await ft('DELETE', `/ext/investments/${matches[0].id}`);
          await reply(`🗑️ Saham *${matches[0].code}* (${matches[0].name}) dihapus dari portofolio.`);
          return;
        }

        pendingConfirm.set(sender, {
          endpoint: '/ext/investments',
          candidates: matches.map(i => ({
            id: i.id,
            label: `${i.code} — ${i.name} (${i.shares} lbr @ ${formatRp(i.buy_price)})`,
          })),
          expiresAt: Date.now() + 2 * 60 * 1000,
        });

        let msg = `🔍 Ditemukan *${matches.length}* saham. Pilih yang mana?\n\n`;
        matches.forEach((i, idx) => {
          msg += `*${idx + 1}.* ${i.code} — ${i.name} (${i.shares} lbr @ ${formatRp(i.buy_price)})\n`;
        });
        msg += `\nBalas dengan angka pilihanmu (berlaku 2 menit).`;
        await reply(msg);
        return;
      }

      // ── update* (ubah data yang sudah ada) ─────────────────────────────────
      const updateResources = { updateTransaction: 'transactions', updateBill: 'bills', updateInvestment: 'investments' };
      if (updateResources[action]) {
        await doUpdate({ resource: updateResources[action], params, sender, reply });
        return;
      }

      // ── addTransactions (banyak sekaligus) ─────────────────────────────────
      if (action === 'addTransactions') {
        await doAddTransactions({ items: params.items, sender, reply });
        return;
      }

      // ── scanReceipt (foto struk) ───────────────────────────────────────────
      if (action === 'scanReceipt') {
        await doScanReceipt({ attachments, text, sender, reply });
        return;
      }

      // ── unknown action ─────────────────────────────────────────────────────
      // ── unknown action ──────────────────────────────────────────────
      // [Fix Bug 2 & 3] Log action mentah + full params saat model (browser-
      // automation scraper Qwen, bukan function-calling API tervalidasi —
      // `enum` di schema TIDAK dijamin server) mengembalikan value di luar
      // enum yang diharapkan. Sebelumnya tidak ada logging di sini, sehingga
      // sulit diagnosa apakah ini murni salah model atau drift enum.
      logger.warn({ intent: 'myFinance', action, params }, '⚠️ myFinance: action tidak dikenali/di luar enum');
      await reply('⚠️ Aksi tidak dikenali. Coba ulangi dengan kalimat yang lebih jelas.');

    } catch (err) {
      logger.error({ intent: 'myFinance', action, err: err.message }, 'Error di plugin myFinance');

      if (err instanceof FinTrackError && err.status === 0) {
        await reply(`❌ FinTrack tidak bisa dihubungi: ${err.message}`);
      } else if (err.message?.includes('Database tidak terhubung') || err.message?.includes('500')) {
        await reply('❌ FinTrack tidak bisa diakses sekarang. Pastikan `database.py` sedang berjalan di Windows.');
      } else {
        await reply(`❌ Gagal: ${err.message}`);
      }
    }
  },
};