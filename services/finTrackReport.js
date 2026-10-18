// services/finTrackReport.js — logika murni laporan keuangan (tanpa I/O): periode WIB,
// ringkasan, anggaran vs realisasi, dan tagihan jatuh tempo. ESM.
import { todayStr, addDays, dowOf, dateLabel, isValidDate, pad } from './calendarFormat.js';

const MONTHS = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];

// ─── Format ──────────────────────────────────────────────────────────────
export const formatRp = (n) => `${Number(n) < 0 ? '-' : ''}Rp ${Math.abs(Number(n) || 0).toLocaleString('id-ID')}`;
const fmtPct = (n) => Number(n).toLocaleString('id-ID', { maximumFractionDigits: 1 });
const signed = (n) => `${n >= 0 ? '+' : '-'}${formatRp(Math.abs(n))}`;
const signedPct = (n) => `${n >= 0 ? '+' : '-'}${fmtPct(Math.abs(n))}%`;

const num = (v) => Number(v) || 0;
const txDate = (t) => String(t?.date || '').slice(0, 10);

// ─── Tanggal ─────────────────────────────────────────────────────────────
export const monthStart = (s) => `${s.slice(0, 8)}01`;
export function nextMonthStart(s) {
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(5, 7));
  return m === 12 ? `${y + 1}-01-01` : `${y}-${pad(m + 1)}-01`;
}
export function prevMonthStart(s) {
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(5, 7));
  return m === 1 ? `${y - 1}-12-01` : `${y}-${pad(m - 1)}-01`;
}
export const monthEnd = (s) => addDays(nextMonthStart(s), -1);
export function diffDays(a, b) {
  const [ay, am, ad] = a.split('-').map(Number);
  const [by, bm, bd] = b.split('-').map(Number);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86400000);
}
const monthLabel = (s) => `${MONTHS[Number(s.slice(5, 7)) - 1]} ${s.slice(0, 4)}`;

/**
 * Terjemahkan parameter periode dari intent menjadi rentang tanggal WIB.
 * @param {{ period?: string, date_from?: string, date_to?: string }} p
 * @returns {{ from: string, to: string, label: string, monthKey: string|null }}
 *          monthKey ('YYYY-MM') terisi bila periode = satu bulan kalender penuh (anggaran berlaku).
 */
export function resolvePeriod(p = {}, today = todayStr()) {
  const key = String(p.period || '').toLowerCase();
  let from;
  let to;
  let label;

  switch (key) {
    case 'today': from = to = today; label = `Hari ini (${dateLabel(today)})`; break;
    case 'yesterday': from = to = addDays(today, -1); label = `Kemarin (${dateLabel(from)})`; break;
    case 'this_week': from = addDays(today, -(dowOf(today) - 1)); to = addDays(from, 6); label = 'Minggu ini'; break;
    case 'last_week': from = addDays(today, -(dowOf(today) - 1) - 7); to = addDays(from, 6); label = 'Minggu lalu'; break;
    case 'last_7_days': from = addDays(today, -6); to = today; label = '7 hari terakhir'; break;
    case 'last_month': from = prevMonthStart(today); to = monthEnd(from); label = monthLabel(from); break;
    case 'this_year': from = `${today.slice(0, 4)}-01-01`; to = `${today.slice(0, 4)}-12-31`; label = `Tahun ${today.slice(0, 4)}`; break;
    case 'custom': {
      const f = isValidDate(p.date_from) ? p.date_from : null;
      const t = isValidDate(p.date_to) ? p.date_to : null;
      if (f || t) {
        from = f || t;
        to = t || today;
        if (to < from) [from, to] = [to, from];
        if (diffDays(from, to) > 366) to = addDays(from, 366);
        label = from === to ? dateLabel(from, true) : `${dateLabel(from, true)} s.d. ${dateLabel(to, true)}`;
      }
      break;
    }
    default: break;
  }

  if (!from) { from = monthStart(today); to = monthEnd(from); label = monthLabel(from); }

  const monthly = from === monthStart(from) && to === monthEnd(from);
  return { from, to, label, monthKey: monthly ? from.slice(0, 7) : null };
}

/** Periode pembanding: bulan sebelumnya (untuk periode bulanan) atau rentang sama panjang tepat sebelumnya. */
export function previousPeriod({ from, to, monthKey }) {
  if (monthKey) {
    const pf = prevMonthStart(from);
    return { from: pf, to: monthEnd(pf), monthKey: pf.slice(0, 7) };
  }
  const len = diffDays(from, to) + 1;
  return { from: addDays(from, -len), to: addDays(from, -1), monthKey: null };
}

// ─── Agregasi ────────────────────────────────────────────────────────────
export function filterTx(transactions, from, to, category = null) {
  const cat = category ? String(category).toLowerCase() : null;
  return (transactions || []).filter((t) => {
    const d = txDate(t);
    if (d < from || d > to) return false;
    return !cat || String(t.category || '').toLowerCase().includes(cat);
  });
}

const sum = (list, type) => list.filter((t) => t.type === type).reduce((s, t) => s + num(t.amount), 0);

/** Anggaran vs realisasi pengeluaran untuk satu bulan ('YYYY-MM'). */
export function budgetStatus(transactions, budgets, monthKey) {
  const spent = new Map();
  for (const t of transactions || []) {
    if (t.type !== 'expense' || !txDate(t).startsWith(monthKey)) continue;
    const c = String(t.category || '').toLowerCase();
    spent.set(c, (spent.get(c) || 0) + num(t.amount));
  }
  return (budgets || [])
    .filter((b) => num(b.limit) > 0)
    .map((b) => {
      const s = spent.get(String(b.category || '').toLowerCase()) || 0;
      return { category: b.category, limit: num(b.limit), spent: s, pct: Math.round((s / num(b.limit)) * 100) };
    });
}

/** Tanggal jatuh tempo berikutnya (>= today) untuk tagihan bulanan; tanggal 31 dipangkas ke akhir bulan. */
export function nextDueDate(dueDay, today = todayStr()) {
  const d = Number(dueDay);
  if (!Number.isInteger(d) || d < 1 || d > 31) return null;
  let ms = monthStart(today);
  for (let i = 0; i < 3; i += 1) {
    const dim = Number(monthEnd(ms).slice(8));
    const cand = `${ms.slice(0, 8)}${pad(Math.min(d, dim))}`;
    if (cand >= today) return cand;
    ms = nextMonthStart(ms);
  }
  return null;
}

/** Tagihan aktif non-autodebit yang jatuh tempo tepat `offsets` hari lagi (mis. [3, 1]). */
export function billsDueIn(bills, offsets, today = todayStr()) {
  const out = [];
  for (const b of bills || []) {
    if (b.active === false || b.autodebit) continue;
    const due = nextDueDate(b.due_day, today);
    if (!due) continue;
    const days = diffDays(today, due);
    if (offsets.includes(days)) out.push({ bill: b, due, days });
  }
  return out;
}

// ─── Laporan periode ─────────────────────────────────────────────────────
/**
 * @param {{ transactions: object[], budgets: object[], bills: object[], investments: object[] }} data
 * @param {{ from: string, to: string, label: string, monthKey: string|null }} period
 * @param {{ category?: string, compact?: boolean, today?: string }} [opts]
 */
export function buildReport(data, period, opts = {}) {
  const today = opts.today || todayStr();
  const { transactions = [], budgets = [], bills = [], investments = [] } = data;
  const { from, to, label, monthKey } = period;
  const category = opts.category ? String(opts.category).trim() : '';

  const tx = filterTx(transactions, from, to, category);
  const income = sum(tx, 'income');
  const expense = sum(tx, 'expense');
  const net = income - expense;

  let msg = `📊 *Laporan Keuangan — ${label}*\n`;
  if (from !== to && !monthKey) msg += `🗓️ ${dateLabel(from, true)} s.d. ${dateLabel(to, true)}\n`;
  if (category) msg += `🔎 Filter kategori: *${category}*\n`;
  msg += '\n';

  if (!tx.length) {
    msg += `Belum ada transaksi${category ? ` untuk kategori "${category}"` : ''} pada periode ini.`;
  } else {
    msg += `💰 *Pemasukan:* ${formatRp(income)}\n`;
    msg += `💸 *Pengeluaran:* ${formatRp(expense)}\n`;
    msg += `${net >= 0 ? '✅' : '⚠️'} *Saldo bersih:* ${formatRp(net)}\n`;

    const elapsedEnd = to < today ? to : today;
    const days = Math.max(1, diffDays(from, elapsedEnd) + 1);
    if (expense > 0 && days > 1) msg += `📉 Rata-rata pengeluaran/hari: ${formatRp(Math.round(expense / days))}\n`;

    // Perbandingan dengan periode sebelumnya. Jika periode masih berjalan, bandingkan dengan
    // rentang awal periode sebelumnya yang sama panjangnya (apple-to-apple), bukan periode penuh.
    const prev = previousPeriod(period);
    let prevTo = prev.to;
    if (to > today) {
      const capped = addDays(prev.from, days - 1);
      if (capped < prevTo) prevTo = capped;
    }
    const prevExpense = sum(filterTx(transactions, prev.from, prevTo, category), 'expense');
    if (prevExpense > 0 && expense > 0) {
      const delta = ((expense - prevExpense) / prevExpense) * 100;
      msg += `↕️ Dibanding periode sebelumnya: pengeluaran ${delta >= 0 ? 'naik' : 'turun'} ${fmtPct(Math.abs(delta))}% (${formatRp(prevExpense)} → ${formatRp(expense)})\n`;
    }

    // Pengeluaran per kategori (+ progres anggaran bila periode = satu bulan)
    const byCat = new Map();
    for (const t of tx.filter((x) => x.type === 'expense')) {
      const c = t.category || 'Lainnya';
      byCat.set(c, (byCat.get(c) || 0) + num(t.amount));
    }
    if (byCat.size) {
      const status = monthKey ? budgetStatus(transactions, budgets, monthKey) : [];
      msg += '\n📂 *Pengeluaran per Kategori:*\n';
      [...byCat.entries()].sort((a, b) => b[1] - a[1]).forEach(([c, amt]) => {
        const share = expense > 0 ? Math.round((amt / expense) * 100) : 0;
        const b = status.find((s) => String(s.category).toLowerCase() === c.toLowerCase());
        msg += `  • ${c}: ${formatRp(amt)} (${share}%)${b ? ` — ${b.pct}% dari anggaran ${formatRp(b.limit)}` : ''}\n`;
      });
    }

    // Status anggaran (hanya periode bulanan & tanpa filter kategori)
    if (monthKey && !category && budgets.length) {
      msg += '\n🎯 *Anggaran:*\n';
      budgetStatus(transactions, budgets, monthKey).forEach((b) => {
        const icon = b.pct >= 100 ? '🔴' : b.pct >= 80 ? '🟡' : '🟢';
        msg += `  ${icon} ${b.category}: ${formatRp(b.spent)} / ${formatRp(b.limit)} (${b.pct}%)\n`;
      });
    }

    if (!opts.compact) {
      // 3 pengeluaran terbesar
      const top = tx.filter((t) => t.type === 'expense').sort((a, b) => num(b.amount) - num(a.amount)).slice(0, 3);
      if (top.length > 1) {
        msg += '\n🏷️ *Pengeluaran Terbesar:*\n';
        top.forEach((t) => { msg += `  • ${formatRp(t.amount)} [${t.category}]${t.description ? ` — ${t.description}` : ''} (${txDate(t)})\n`; });
      }
    }
  }

  if (!opts.compact) {
    const includesToday = from <= today && today <= to;

    // Tagihan rutin aktif
    const active = bills.filter((b) => b.active !== false);
    if (includesToday && active.length) {
      msg += `\n🧾 *Tagihan Rutin Aktif (${active.length}):* total ${formatRp(active.reduce((s, b) => s + num(b.amount), 0))}/bln\n`;
      active
        .map((b) => ({ b, due: nextDueDate(b.due_day, today) }))
        .filter((x) => x.due)
        .sort((a, b) => a.due.localeCompare(b.due))
        .slice(0, 5)
        .forEach(({ b, due }) => {
          const d = diffDays(today, due);
          msg += `  • ${b.name}: ${formatRp(b.amount)} — ${d === 0 ? 'hari ini' : d === 1 ? 'besok' : `${d} hari lagi`} (tgl ${b.due_day})${b.autodebit ? ' 🔄' : ''}\n`;
        });
    }

    // Investasi (hanya modal)
    if (includesToday && investments.length) {
      const cost = investments.reduce((s, i) => s + num(i.shares) * num(i.buy_price), 0);
      msg += `\n📈 *Investasi:* ${investments.length} posisi, total modal ${formatRp(cost)}\n`;
    }

    // 5 transaksi terbaru di periode
    const recent = tx
      .map((t, i) => ({ t, i }))
      .sort((a, b) => txDate(b.t).localeCompare(txDate(a.t)) || b.i - a.i)
      .slice(0, 5)
      .map((x) => x.t);
    if (recent.length) {
      msg += '\n🕐 *Transaksi Terbaru:*\n';
      recent.forEach((t) => { msg += `  ${t.type === 'income' ? '➕' : '➖'} ${formatRp(t.amount)} [${t.category}]${t.description ? ` — ${t.description}` : ''} (${txDate(t)})\n`; });
    }
  }

  return msg.trim();
}
