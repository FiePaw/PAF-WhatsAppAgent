// services/lmsClient.js — Klien HTTP ke LMS Telkom Scraper API. ESM.
// API lokal berbasis FastAPI + Playwright.
// Env (.env): LMS_API_URL=http://127.0.0.1:8000  LMS_API_KEY=<kunci jika diset>

import config from '../config/config.js';
import { dateLabel, hm, todayStr, wibParts } from './calendarFormat.js';

const DEFAULT_TIMEOUT_MS = 15000;
const REFRESH_TIMEOUT_MS = 90000;

export class LMSClientError extends Error {
  constructor(message, status = 0, code = null) {
    super(message);
    this.name = 'LMSClientError';
    this.status = status;
    this.code = code;
  }
}

const baseUrl = () => (process.env.LMS_API_URL || config.lms?.baseUrl || 'http://127.0.0.1:8000').replace(/\/+$/, '');
const apiKey = () => process.env.LMS_API_KEY || config.lms?.apiKey || '';

async function request(method, path, { query, body, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const url = new URL(`${baseUrl()}${path}`);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== '') {
        url.searchParams.set(k, String(v));
      }
    }
  }

  const headers = { 'Content-Type': 'application/json' };
  const key = apiKey();
  if (key) headers['X-API-Key'] = key;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    throw new LMSClientError(
      err.name === 'AbortError'
        ? 'LMS Telkom API tidak merespons (timeout)'
        : `Tidak dapat menghubungi LMS Telkom API (${err.cause?.code || err.message})`,
      0,
      'NETWORK'
    );
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON */
  }

  if (!res.ok) {
    const msg =
      res.status === 401
        ? 'API Key LMS salah atau belum diatur (LMS_API_KEY)'
        : (data && (data.detail || data.error)) || `HTTP ${res.status}`;
    throw new LMSClientError(msg, res.status, data && data.code);
  }

  return data;
}

// ─── Endpoint API ────────────────────────────────────────────────────────────

/** Status server, browser, waktu scrape terakhir, dan jumlah data */
export const getHealth = () => request('GET', '/health');

/** Memaksa sinkronisasi/scraping sekarang */
export const refresh = ({ full = false, deep_courses = false } = {}) =>
  request('POST', '/refresh', { query: { full, deep_courses }, timeoutMs: REFRESH_TIMEOUT_MS });

/**
 * Cek kuis (perlu attempt) & tugas (perlu submit) per mata kuliah.
 *
 * @param {object} [opts]
 * @param {'pending'|'completed'|'all'} [opts.status='pending']
 * @param {'quiz'|'assign'} [opts.type]
 * @param {string} [opts.course]
 * @param {'auto'|'deep'|'timeline'} [opts.source='auto']
 * @param {boolean} [opts.deep=false]
 */
export const getPendingTasks = ({ status = 'pending', type, course, source = 'auto', deep = false } = {}) =>
  request('GET', '/courses/pending-tasks', { query: { status, type, course, source, deep } });

/**
 * Mengambil daftar timeline deadline dari dashboard LMS.
 *
 * @param {object} [opts]
 * @param {number} [opts.days=14]
 * @param {'all'|'pending'|'overdue'|'submitted'} [opts.status='all']
 */
export const getTimeline = ({ days = 14, status = 'all' } = {}) =>
  request('GET', '/timeline', { query: { days, status } });

/**
 * Daftar notifikasi LMS.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.unread_only=false]
 * @param {number} [opts.limit=20]
 * @param {'academic'|'announcement'|'reminder'|'forum'|'other'} [opts.category]
 */
export const getNotifications = ({ unread_only = false, limit = 20, category } = {}) =>
  request('GET', '/notifications', { query: { unread_only, limit, category } });

// ─── Format Helpers untuk Tampilan Pesan WhatsApp ─────────────────────────────

/**
 * Format tanggal ISO (WIB) ke teks ramah WhatsApp.
 * Contoh: "Senin, 26 Okt 23:59 WIB"
 */
export function formatDue(isoStr) {
  if (!isoStr) return 'Tidak ada deadline';
  try {
    const d = new Date(isoStr);
    if (isNaN(d.getTime())) return isoStr;
    const datePart = isoStr.slice(0, 10);
    const timePart = hm(d.getTime());
    return `${dateLabel(datePart)} jam ${timePart} WIB`;
  } catch {
    return isoStr;
  }
}

/**
 * Format respons getPendingTasks menjadi teks rapi untuk WhatsApp.
 */
export function formatPendingTasksView(data, filterLabel = '') {
  const summary = data?.summary || {};
  const courses = data?.courses || [];

  if (!courses.length || summary.total_pending === 0) {
    return `🎉 *LMS Telkom University*\n\nTidak ada tugas atau kuis pending${filterLabel ? ` (${filterLabel})` : ''}. Semua aman!`;
  }

  let text = `📚 *LMS Telkom — Tugas & Kuis Pending*\n`;
  text += `📊 Total: *${summary.total_pending || 0}* pending (*${summary.pending_quizzes || 0}* kuis, *${summary.pending_assignments || 0}* tugas)\n\n`;

  for (const c of courses) {
    if (!c.tasks || !c.tasks.length) continue;
    // Bersihkan nama course agar tidak terlalu panjang (buang kode kelas di kurung siku jika ada)
    const cleanCourseName = c.course_name.replace(/\s*\[.*?\]/g, '').trim();
    text += `*📖 ${cleanCourseName}* (${c.tasks.length} pending):\n`;

    for (const t of c.tasks) {
      const isQuiz = t.module_type === 'quiz';
      const icon = isQuiz ? '📝 [Kuis]' : '📌 [Tugas]';
      const due = formatDue(t.due_at);
      const overdueTag = t.overdue ? ' ⚠️ *OVERDUE*' : '';
      const actionTag = t.action_needed ? ` _(butuh ${t.action_needed})_` : '';

      text += `  • ${icon} *${t.title}*\n`;
      text += `    ⏳ Deadline: ${due}${overdueTag}${actionTag}\n`;
      if (t.section) text += `    📂 Sesi: ${t.section}\n`;
      if (t.url) text += `    🔗 ${t.url}\n`;
    }
    text += '\n';
  }

  return text.trim();
}

/**
 * Format respons getTimeline menjadi teks ringkas.
 */
export function formatTimelineView(data, days = 14) {
  const items = data?.items || [];
  if (!items.length) {
    return `📅 *LMS Timeline (${days} Hari ke Depan)*\n\nTidak ada aktivitas/deadline yang terdaftar.`;
  }

  let text = `📅 *LMS Timeline (${days} Hari ke Depan)*\nTotal: *${items.length}* item\n\n`;
  for (const item of items) {
    const icon = item.type === 'quiz' ? '📝' : '📌';
    const due = formatDue(item.due_at);
    const overdue = item.is_overdue ? ' ⚠️ *OVERDUE*' : '';
    text += `${icon} *${item.title}*\n`;
    text += `   📚 ${item.course || '-'}\n`;
    text += `   ⏳ ${due}${overdue}\n`;
    if (item.action_url) text += `   🔗 ${item.action_url}\n`;
    text += '\n';
  }

  return text.trim();
}

/**
 * Format respons getNotifications menjadi teks notifikasi.
 */
export function formatNotificationsView(data) {
  const notifs = data?.notifications || [];
  if (!notifs.length) {
    return '🔔 *Notifikasi LMS Telkom*\n\nTidak ada notifikasi baru.';
  }

  let text = `🔔 *Notifikasi LMS Telkom* (${notifs.length} terbaru):\n\n`;
  for (const n of notifs.slice(0, 10)) {
    const unread = !n.is_read ? '🔹 ' : '';
    text += `${unread}*${n.title}*\n`;
    if (n.text) text += `   ${n.text.slice(0, 120)}${n.text.length > 120 ? '...' : ''}\n`;
    if (n.course) text += `   📖 ${n.course}\n`;
    if (n.date_text) text += `   🕒 ${n.date_text}\n`;
    text += '\n';
  }

  return text.trim();
}
