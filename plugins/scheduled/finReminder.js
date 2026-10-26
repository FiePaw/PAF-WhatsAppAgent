// plugins/scheduled/finReminder.js — pengingat keuangan otomatis dari data FinTrack.
//   • Tagihan jatuh tempo H-3 dan H-1 (tagihan auto-debit dilewati)
//   • Anggaran bulan ini mendekati batas (80%) / terlampaui (100%) — sekali per kategori per bulan
//   • Ringkasan mingguan setiap Minggu malam
// Tujuan kirim: grup yang di-assign `!group channel <groupJid> myFinance output`, fallback DM owner.
// Pesan hanya dikirim 07:00–21:59 WIB. State "sudah dikirim" disimpan di data/finReminderState.json
// agar restart bot tidak mengirim ulang.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { getSummary, FinTrackError } from '../../services/finTrackClient.js';
import { billsDueIn, budgetStatus, buildReport, formatRp, resolvePeriod } from '../../services/finTrackReport.js';
import { dateLabel, todayStr, wibParts } from '../../services/calendarFormat.js';
import { getGroupOutput } from '../../services/groupService.js';
import config from '../../config/config.js';
import logger from '../../utils/logger.js';

const PLUGIN_KEYS = ['myFinance', 'myfinance']; // key grup bisa tersimpan dengan huruf berbeda
const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'data');
const STATE_FILE = join(DATA_DIR, 'finReminderState.json');
const KEEP_MS = 90 * 24 * 3600 * 1000;
const FIRST_HOUR = 7;   // jam WIB paling awal
const LAST_HOUR = 21;   // jam WIB paling akhir (inklusif)
const DIGEST_HOUR = 8;  // pengingat tagihan mulai jam ini
const WEEKLY_HOUR = 19; // ringkasan mingguan (Minggu)

let running = false;

// ─── State dedupe ────────────────────────────────────────────────────────
function loadState() {
  try {
    if (existsSync(STATE_FILE)) {
      const j = JSON.parse(readFileSync(STATE_FILE, 'utf-8'));
      if (j && typeof j.sent === 'object') return j;
    }
  } catch { /* file rusak → mulai kosong */ }
  return { sent: {} };
}

function saveState(state) {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    const cutoff = Date.now() - KEEP_MS;
    for (const [k, at] of Object.entries(state.sent)) if (Date.parse(at) < cutoff) delete state.sent[k];
    writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf-8');
  } catch (err) {
    logger.warn({ err: err.message }, '⚠️ finReminder: gagal simpan state');
  }
}

// ─── Kirim ───────────────────────────────────────────────────────────────
function targets() {
  const groups = [...new Set(PLUGIN_KEYS.flatMap((k) => getGroupOutput(k) || []))];
  if (groups.length) return groups;
  const owner = config.ownerLid || config.ownerJid;
  return owner ? [owner] : [];
}

/** Sukses bila minimal satu target menerima. */
async function send(text) {
  const sock = global._sock;
  if (!sock) throw new Error('bot offline (_sock null)');
  const list = targets();
  if (!list.length) throw new Error('tidak ada target kirim (grup channel/owner)');
  let ok = 0;
  for (const jid of list) {
    try { await sock.sendMessage(jid, { text }); ok += 1; } catch (err) {
      logger.warn({ jid, err: err.message }, '⚠️ finReminder: gagal kirim ke target');
    }
  }
  if (!ok) throw new Error('semua target gagal');
}

// ─── Penyusun pesan (murni, mudah diuji) ─────────────────────────────────
export function buildBillReminder(due) {
  const lines = due
    .sort((a, b) => a.days - b.days)
    .map(({ bill, due: d, days }) => `• ${bill.name}: ${formatRp(bill.amount)} — ${days === 1 ? '*besok*' : `${days} hari lagi`} (${dateLabel(d)})`);
  return `🧾 *Pengingat Tagihan*\n${lines.join('\n')}`;
}

export function buildBudgetAlert(b) {
  return b.pct >= 100
    ? `🔴 *Anggaran ${b.category} terlampaui!*\nTerpakai ${formatRp(b.spent)} dari ${formatRp(b.limit)} (${b.pct}%).`
    : `🟡 *Anggaran ${b.category} hampir habis.*\nTerpakai ${formatRp(b.spent)} dari ${formatRp(b.limit)} (${b.pct}%) — sisa ${formatRp(b.limit - b.spent)}.`;
}

/** Tentukan pesan apa saja yang jatuh tempo dikirim sekarang. Kembalikan [{ key(s), text }]. */
export function collectReminders(data, state, now = Date.now()) {
  const p = wibParts(now);
  const today = todayStr(now);
  const month = today.slice(0, 7);
  const out = [];
  if (p.h < FIRST_HOUR || p.h > LAST_HOUR) return out;

  // 1) Tagihan H-3 & H-1 (mulai jam 08:00), digabung dalam satu pesan
  if (p.h >= DIGEST_HOUR) {
    const items = billsDueIn(data.bills, [3, 1], today)
      .map((x) => ({ ...x, key: `bill:${x.bill.id}:${x.due}:H${x.days}` }))
      .filter((x) => !state.sent[x.key]);
    if (items.length) out.push({ keys: items.map((x) => x.key), text: buildBillReminder(items) });
  }

  // 2) Anggaran bulan ini: 80% dan 100% (sekali per kategori per bulan)
  for (const b of budgetStatus(data.transactions, data.budgets, month)) {
    const k100 = `budget:${b.category}:${month}:100`;
    const k80 = `budget:${b.category}:${month}:80`;
    if (b.pct >= 100 && !state.sent[k100]) out.push({ keys: [k100, k80], text: buildBudgetAlert(b) });
    else if (b.pct >= 80 && b.pct < 100 && !state.sent[k80] && !state.sent[k100]) out.push({ keys: [k80], text: buildBudgetAlert(b) });
  }

  // 3) Ringkasan mingguan — Minggu (dow 7) mulai 19:00
  const wk = `weekly:${today}`;
  if (p.dow === 7 && p.h >= WEEKLY_HOUR && !state.sent[wk]) {
    const period = resolvePeriod({ period: 'last_7_days' }, today);
    out.push({ keys: [wk], text: `🗓️ *Ringkasan Mingguan*\n\n${buildReport(data, period, { compact: true, today })}` });
  }
  return out;
}

// ─── Siklus ──────────────────────────────────────────────────────────────
async function tick() {
  if (running) return;
  if (!global._sock) return; // bot offline: jangan tandai terkirim
  running = true;
  try {
    const p = wibParts(Date.now());
    if (p.h < FIRST_HOUR || p.h > LAST_HOUR) return; // jam tenang

    let summary;
    try {
      summary = await getSummary();
    } catch (err) {
      // FinTrack/PC offline: lewati siklus; jangan berisik
      if (!(err instanceof FinTrackError && err.status === 0)) logger.warn({ err: err.message }, '⚠️ finReminder: gagal ambil summary');
      return;
    }
    const arr = (v) => (Array.isArray(v) ? v : []);
    const data = {
      transactions: arr(summary?.transactions),
      budgets: arr(summary?.budgets),
      bills: arr(summary?.bills),
      investments: arr(summary?.investments),
    };

    const state = loadState();
    const reminders = collectReminders(data, state);
    let changed = false;
    for (const r of reminders) {
      try {
        await send(r.text);
        const at = new Date().toISOString();
        for (const k of r.keys) state.sent[k] = at; // tandai hanya setelah sukses kirim
        changed = true;
      } catch (err) {
        logger.warn({ keys: r.keys, err: err.message }, '⚠️ finReminder: kirim gagal, dicoba lagi di siklus berikutnya');
      }
    }
    if (changed) saveState(state);
  } catch (err) {
    logger.error({ err: err.message }, '❌ finReminder: error tak terduga');
  } finally {
    running = false;
  }
}

export default {
  name: 'Finance Reminder',
  description: 'Pengingat tagihan H-3/H-1, peringatan anggaran 80%/100%, dan ringkasan mingguan FinTrack',
  crons: [
    {
      name: 'scheduled:finReminder',
      expr: '@every_30m',
      handler: tick,
      runOnStart: true,
    },
  ],
};
