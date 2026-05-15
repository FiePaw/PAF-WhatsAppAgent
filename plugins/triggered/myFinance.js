// plugins/triggered/myFinance.js
import logger from '../../utils/logger.js';

// ─── CONFIG ──────────────────────────────────────────────────────────────────
const FINTRACK_BASE = 'http://108.137.15.61:9550';
const FINTRACK_KEY  = 'fintrack-ext-key'; // ganti sesuai API key kamu

// ─── HELPER ──────────────────────────────────────────────────────────────────
async function ft(method, path, body = null) {
  const res = await fetch(`${FINTRACK_BASE}${path}`, {
    method,
    headers: {
      'X-API-Key': FINTRACK_KEY,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await res.json();

  if (!res.ok) {
    throw new Error(data?.error || `HTTP ${res.status}`);
  }

  return data;
}

function formatRp(amount) {
  return `Rp ${Number(amount).toLocaleString('id-ID')}`;
}

function todayDate() {
  return new Date().toISOString().split('T')[0];
}

// ─── PENDING CONFIRMATIONS (in-memory) ───────────────────────────────────────
// key: senderJid → { action, candidates: [{id, label}], expiresAt }
const pendingConfirm = new Map();


export default {
  intent: 'myFinance',

  intentDefinition: `"myFinance" - owner ingin melakukan operasi keuangan pribadi via FinTrack. Ekstrak:
  action (string, salah satu dari: addTransaction | deleteTransaction | addBudget | deleteBudget | addBill | deleteBill | addInvestment | deleteInvestment | getSummary | confirmDelete),
  type (string, "income" atau "expense" — hanya untuk addTransaction),
  amount (number, nominal dalam Rupiah — untuk addTransaction, addBudget, addBill, addInvestment),
  category (string, kategori transaksi/anggaran/tagihan),
  date (string, format YYYY-MM-DD, jika tidak disebut kosongkan),
  description (string, keterangan transaksi — untuk addTransaction),
  searchKeyword (string, kata kunci nama/deskripsi untuk mencari item yang mau dihapus — untuk deleteTransaction, deleteBudget, deleteBill, deleteInvestment),
  confirmIndex (number, angka pilihan yang dipilih owner saat konfirmasi hapus — untuk confirmDelete),
  name (string, nama tagihan — untuk addBill),
  due_day (number, tanggal jatuh tempo 1-31 — untuk addBill),
  autodebit (boolean, apakah auto-debit — untuk addBill),
  notes (string, catatan — untuk addBill, addInvestment),
  code (string, kode saham IDX huruf kapital — untuk addInvestment),
  stockName (string, nama perusahaan saham — untuk addInvestment),
  shares (number, jumlah lembar saham — untuk addInvestment),
  buy_price (number, harga beli per lembar — untuk addInvestment),
  buy_date (string, tanggal beli YYYY-MM-DD — untuk addInvestment).
  Intent getSummary aktif jika owner minta laporan, ringkasan, atau info keuangan.
  Intent confirmDelete aktif jika owner menyebut angka/nomor sebagai pilihan dari daftar hapus sebelumnya.`,

  groupContextPrompt: `Kamu adalah asisten keuangan pribadi owner. Kamu memahami semua data keuangan owner: transaksi pemasukan dan pengeluaran, anggaran per kategori, tagihan rutin bulanan, dan portofolio investasi saham IDX. Bantu owner mencatat, mengelola, dan memahami kondisi keuangannya. Jawab ringkas dan pakai Bahasa Indonesia. Saat owner menyebut nominal uang, asumsikan dalam Rupiah.`,

  name: 'MyFinance',
  description: 'Manajemen keuangan pribadi via FinTrack API',
  ownerOnly: true,

  handler: async ({ params, sender, reply }) => {
    const { action } = params;

    try {
      // ── confirmDelete ──────────────────────────────────────────────────────
      if (action === 'confirmDelete') {
        const pending = pendingConfirm.get(sender);
        if (!pending || Date.now() > pending.expiresAt) {
          pendingConfirm.delete(sender);
          await reply('⏰ Tidak ada konfirmasi hapus yang aktif atau sudah kedaluwarsa.');
          return;
        }

        const idx = Number(params.confirmIndex) - 1;
        if (isNaN(idx) || idx < 0 || idx >= pending.candidates.length) {
          await reply(`❓ Pilihan tidak valid. Ketik angka 1–${pending.candidates.length}.`);
          return;
        }

        const target = pending.candidates[idx];
        pendingConfirm.delete(sender);

        await ft('DELETE', `${pending.endpoint}/${target.id}`);
        await reply(`🗑️ Berhasil dihapus:\n*${target.label}*`);
        return;
      }

      // ── getSummary ─────────────────────────────────────────────────────────
      if (action === 'getSummary') {
        const summary = await ft('GET', '/ext/summary');
        logger.info({ summaryKeys: Object.keys(summary) }, '📦 myFinance: summary response keys');

        const transactions = Array.isArray(summary.transactions) ? summary.transactions : [];
        const budgets      = Array.isArray(summary.budgets)      ? summary.budgets      : [];
        const bills        = Array.isArray(summary.bills)        ? summary.bills        : [];
        const investments  = Array.isArray(summary.investments)  ? summary.investments  : [];

        const now = new Date();
        const thisMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

        const txMonth = transactions.filter(t => t.date?.startsWith(thisMonth));
        const totalIncome  = txMonth.filter(t => t.type === 'income').reduce((s, t) => s + t.amount, 0);
        const totalExpense = txMonth.filter(t => t.type === 'expense').reduce((s, t) => s + t.amount, 0);
        const saldo = totalIncome - totalExpense;

        // Pengeluaran per kategori bulan ini
        const byCategory = {};
        txMonth.filter(t => t.type === 'expense').forEach(t => {
          byCategory[t.category] = (byCategory[t.category] || 0) + t.amount;
        });

        const activeBills = bills.filter(b => b.active);
        const totalBills  = activeBills.reduce((s, b) => s + b.amount, 0);

        // Investasi
        const totalInvested = investments.reduce((s, i) => s + (i.shares * i.buy_price), 0);

        // ── Bangun pesan ──
        let msg = `📊 *Laporan Keuangan — ${now.toLocaleString('id-ID', { month: 'long', year: 'numeric' })}*\n\n`;

        // Ringkasan bulan ini
        msg += `💰 *Pemasukan:* ${formatRp(totalIncome)}\n`;
        msg += `💸 *Pengeluaran:* ${formatRp(totalExpense)}\n`;
        msg += `${saldo >= 0 ? '✅' : '⚠️'} *Saldo bersih:* ${formatRp(saldo)}\n`;

        // Pengeluaran per kategori
        if (Object.keys(byCategory).length > 0) {
          msg += `\n📂 *Pengeluaran per Kategori:*\n`;
          Object.entries(byCategory)
            .sort((a, b) => b[1] - a[1])
            .forEach(([cat, amt]) => {
              const budget = budgets.find(b => b.category === cat);
              const pct    = budget ? Math.round((amt / budget.limit) * 100) : null;
              const bar    = pct !== null ? ` (${pct}% dari anggaran ${formatRp(budget.limit)})` : '';
              msg += `  • ${cat}: ${formatRp(amt)}${bar}\n`;
            });
        }

        // Anggaran
        if (budgets.length > 0) {
          msg += `\n🎯 *Anggaran yang Dikonfigurasi:*\n`;
          budgets.forEach(b => {
            const spent = byCategory[b.category] || 0;
            const pct   = Math.round((spent / b.limit) * 100);
            const icon  = pct >= 100 ? '🔴' : pct >= 80 ? '🟡' : '🟢';
            msg += `  ${icon} ${b.category}: ${formatRp(spent)} / ${formatRp(b.limit)} (${pct}%)\n`;
          });
        }

        // Tagihan aktif
        if (activeBills.length > 0) {
          msg += `\n🧾 *Tagihan Rutin Aktif (${activeBills.length}):*\n`;
          activeBills
            .sort((a, b) => a.due_day - b.due_day)
            .forEach(b => {
              const ad = b.autodebit ? ' 🔄' : '';
              msg += `  • ${b.name}: ${formatRp(b.amount)} (tgl ${b.due_day})${ad}\n`;
            });
          msg += `  *Total tagihan:* ${formatRp(totalBills)}/bln\n`;
        }

        // Investasi
        if (investments.length > 0) {
          msg += `\n📈 *Portofolio Investasi (${investments.length} saham):*\n`;
          investments.forEach(i => {
            msg += `  • ${i.code} — ${i.shares} lbr @ ${formatRp(i.buy_price)}\n`;
          });
          msg += `  *Total investasi:* ${formatRp(totalInvested)}\n`;
        }

        // Transaksi terbaru (5 terakhir)
        const recent = [...transactions].reverse().slice(0, 5);
        if (recent.length > 0) {
          msg += `\n🕐 *5 Transaksi Terakhir:*\n`;
          recent.forEach(t => {
            const icon = t.type === 'income' ? '➕' : '➖';
            const desc = t.description ? ` — ${t.description}` : '';
            msg += `  ${icon} ${formatRp(t.amount)} [${t.category}]${desc} (${t.date})\n`;
          });
        }

        await reply(msg.trim());
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

      // ── addBudget ──────────────────────────────────────────────────────────
      if (action === 'addBudget') {
        const { category, amount } = params;
        if (!category || !amount) {
          await reply('⚠️ Sebutkan kategori dan nominal anggaran.');
          return;
        }

        const budget = await ft('POST', '/ext/budgets', {
          category,
          limit: Number(amount),
        });

        await reply(
          `✅ *Anggaran ditambahkan!*\n` +
          `📂 ${budget.category}\n` +
          `🎯 Limit: ${formatRp(budget.limit)}/bulan`
        );
        return;
      }

      // ── deleteBudget ───────────────────────────────────────────────────────
      if (action === 'deleteBudget') {
        const { searchKeyword } = params;
        if (!searchKeyword) {
          await reply('⚠️ Sebutkan kategori anggaran yang ingin dihapus.');
          return;
        }

        const budgets = await ft('GET', '/ext/budgets');
        const keyword = searchKeyword.toLowerCase();
        const matches = budgets.filter(b => b.category?.toLowerCase().includes(keyword));

        if (matches.length === 0) {
          await reply(`❌ Tidak ada anggaran untuk kategori "*${searchKeyword}*".`);
          return;
        }

        if (matches.length === 1) {
          await ft('DELETE', `/ext/budgets/${matches[0].id}`);
          await reply(`🗑️ Anggaran *${matches[0].category}* (${formatRp(matches[0].limit)}/bln) dihapus.`);
          return;
        }

        pendingConfirm.set(sender, {
          endpoint: '/ext/budgets',
          candidates: matches.map(b => ({
            id: b.id,
            label: `${b.category} — limit ${formatRp(b.limit)}/bln`,
          })),
          expiresAt: Date.now() + 2 * 60 * 1000,
        });

        let msg = `🔍 Ditemukan *${matches.length}* anggaran. Pilih yang mana?\n\n`;
        matches.forEach((b, i) => {
          msg += `*${i + 1}.* ${b.category} — limit ${formatRp(b.limit)}/bln\n`;
        });
        msg += `\nBalas dengan angka pilihanmu (berlaku 2 menit).`;
        await reply(msg);
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

      // ── unknown action ─────────────────────────────────────────────────────
      await reply('⚠️ Aksi tidak dikenali. Coba ulangi dengan kalimat yang lebih jelas.');

    } catch (err) {
      logger.error({ intent: 'myFinance', action, err: err.message }, 'Error di plugin myFinance');

      if (err.message?.includes('Database tidak terhubung') || err.message?.includes('500')) {
        await reply('❌ FinTrack tidak bisa diakses sekarang. Pastikan `database.py` sedang berjalan di Windows.');
      } else {
        await reply(`❌ Gagal: ${err.message}`);
      }
    }
  },
};