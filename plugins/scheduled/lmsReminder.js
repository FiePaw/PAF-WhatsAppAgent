// plugins/scheduled/lmsReminder.js — Pengingat berkala deadline tugas & kuis LMS Telkom (< 24 jam & overdue).
// Tujuan kirim: grup yang di-assign `!group channel <groupJid> lms output`, fallback DM owner.
// Hanya aktif pada jam 07:00–22:00 WIB. State tersimpan di data/lmsReminderState.json.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import * as lms from '../../services/lmsClient.js';
import { dateLabel, hm, todayStr, wibParts } from '../../services/calendarFormat.js';
import { getGroupOutput } from '../../services/groupService.js';
import config from '../../config/config.js';
import logger from '../../utils/logger.js';

const PLUGIN_KEY = 'lms';
const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'data');
const STATE_FILE = join(DATA_DIR, 'lmsReminderState.json');
const KEEP_MS = 30 * 24 * 3600 * 1000; // 30 hari
const FIRST_HOUR = 7;
const LAST_HOUR = 22;

let running = false;

// ─── State Management ────────────────────────────────────────────────────────
function loadState() {
  try {
    if (existsSync(STATE_FILE)) {
      const j = JSON.parse(readFileSync(STATE_FILE, 'utf-8'));
      if (j && typeof j.sent === 'object') return j;
    }
  } catch {
    /* file corrupt/empty */
  }
  return { sent: {} };
}

function saveState(state) {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    const cutoff = Date.now() - KEEP_MS;
    for (const [k, at] of Object.entries(state.sent)) {
      if (Date.parse(at) < cutoff) delete state.sent[k];
    }
    writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf-8');
  } catch (err) {
    logger.warn({ err: err.message }, '⚠️ lmsReminder: gagal simpan state');
  }
}

// ─── Target Pengiriman ────────────────────────────────────────────────────────
function targets() {
  const groups = getGroupOutput(PLUGIN_KEY) || [];
  if (groups.length) return groups;
  const owner = config.ownerLid || config.ownerJid;
  return owner ? [owner] : [];
}

async function send(text) {
  const sock = global._sock;
  if (!sock) throw new Error('bot offline (_sock null)');
  const list = targets();
  if (!list.length) throw new Error('tidak ada target kirim (grup channel/owner)');
  let ok = 0;
  for (const jid of list) {
    try {
      await sock.sendMessage(jid, { text });
      ok += 1;
    } catch (err) {
      logger.warn({ jid, err: err.message }, '⚠️ lmsReminder: gagal kirim ke target');
    }
  }
  if (!ok) throw new Error('semua target gagal');
}

// ─── Logika Pengumpulan Tugas Mendesak ─────────────────────────────────────────
function collectUrgentTasks(data, state, nowMs) {
  const courses = data?.courses || [];
  const urgent = [];
  const dayKey = todayStr(nowMs);

  for (const c of courses) {
    for (const t of c.tasks || []) {
      if (!t.due_at) continue;
      const dueMs = new Date(t.due_at).getTime();
      const diffHours = (dueMs - nowMs) / (3600 * 1000);

      // Kriteria mendesak:
      // 1. Sudah OVERDUE (belum lewat dari 48 jam)
      // 2. Deadline dalam 24 jam ke depan (diffHours > 0 dan <= 24)
      const isOverdue = t.overdue || diffHours < 0;
      const isDueSoon = !isOverdue && diffHours <= 24 && diffHours >= 0;

      if (!isOverdue && !isDueSoon) continue;

      const subKey = isOverdue ? 'overdue' : 'h24';
      // Key unik harian per task agar tidak spam berkali-kali di hari yang sama
      const stateKey = `lms:${t.id || t.title}:${dayKey}:${subKey}`;

      if (!state.sent[stateKey]) {
        urgent.push({
          task: t,
          courseName: c.course_name.replace(/\s*\[.*?\]/g, '').trim(),
          isOverdue,
          diffHours: Math.max(0, Math.round(diffHours)),
          stateKey,
        });
      }
    }
  }

  return urgent;
}

function buildUrgentMessage(urgentItems) {
  let msg = `⚠️ *PENGINGAT DEADLINE LMS TELKOM*\n`;
  msg += `Ditemukan *${urgentItems.length}* tugas/kuis yang membutuhkan perhatian segera:\n\n`;

  for (const item of urgentItems) {
    const t = item.task;
    const isQuiz = t.module_type === 'quiz';
    const icon = isQuiz ? '📝 [Kuis]' : '📌 [Tugas]';
    const statusText = item.isOverdue
      ? '🚨 *SUDAH OVERDUE!*'
      : `⏳ *${item.diffHours} jam lagi* (${lms.formatDue(t.due_at)})`;

    msg += `• ${icon} *${t.title}*\n`;
    msg += `  📖 ${item.courseName}\n`;
    msg += `  Status: ${statusText}\n`;
    if (t.url) msg += `  🔗 ${t.url}\n`;
    msg += '\n';
  }

  msg += `_Segera selesaikan dan kumpulkan melalui LMS Telkom._`;
  return msg.trim();
}

// ─── Handler Siklus Cron ──────────────────────────────────────────────────────
async function tick() {
  if (running) return;
  if (!global._sock) return; // bot offline
  running = true;

  try {
    const now = Date.now();
    const p = wibParts(now);
    if (p.h < FIRST_HOUR || p.h > LAST_HOUR) return; // jam istirahat

    let pendingData;
    try {
      pendingData = await lms.getPendingTasks({ status: 'pending' });
    } catch (err) {
      // Jika LMS API offline atau timeout, lewati siklus tanpa spamming error log
      if (err instanceof lms.LMSClientError && err.status === 0) return;
      logger.warn({ err: err.message }, '⚠️ lmsReminder: gagal ambil pending tasks');
      return;
    }

    const state = loadState();
    const urgentItems = collectUrgentTasks(pendingData, state, now);

    if (!urgentItems.length) return;

    const message = buildUrgentMessage(urgentItems);
    try {
      await send(message);
      const isoNow = new Date(now).toISOString();
      for (const item of urgentItems) {
        state.sent[item.stateKey] = isoNow;
      }
      saveState(state);
      logger.info({ count: urgentItems.length }, '📢 lmsReminder: pengingat deadline LMS berhasil dikirim');
    } catch (sendErr) {
      logger.warn({ err: sendErr.message }, '⚠️ lmsReminder: gagal mengirim pesan pengingat');
    }
  } catch (err) {
    logger.error({ err: err.message }, '❌ lmsReminder: error tak terduga pada siklus pengingat');
  } finally {
    running = false;
  }
}

export default {
  name: 'LMS Deadline Reminder',
  description: 'Pengingat berkala deadline tugas dan kuis LMS Telkom (< 24 jam & overdue)',
  crons: [
    {
      name: 'scheduled:lmsReminder',
      expr: '@every_30m',
      handler: tick,
      runOnStart: true,
    },
  ],
};
