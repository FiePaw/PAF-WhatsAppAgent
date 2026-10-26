// services/calendarClient.js — klien HTTP ke MyCalendar (/ext/*). ESM.
// Env bot (.env): CALENDAR_API_URL=http://<host-vps>:9570  CALENDAR_API_KEY=<EXT_API_KEY server MyCalendar>
// Env dibaca saat dipanggil (bukan saat modul dimuat) agar tidak tergantung urutan load dotenv.

const TIMEOUT_MS = 10000;

export class CalendarClientError extends Error {
  constructor(message, status = 0, code = null) {
    super(message);
    this.name = 'CalendarClientError';
    this.status = status;
    this.code = code;
  }
}

const baseUrl = () => (process.env.CALENDAR_API_URL || 'http://20.239.192.10:9570').replace(/\/+$/, '');
const apiKey = () => process.env.CALENDAR_API_KEY || '';

async function request(method, path, { query, body, timeoutMs = TIMEOUT_MS } = {}) {
  const url = new URL(`${baseUrl()}/ext${path}`);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey() },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    throw new CalendarClientError(
      err.name === 'AbortError' ? 'MyCalendar tidak merespons (timeout)' : `Tidak dapat menghubungi MyCalendar (${err.cause?.code || err.message})`,
      0, 'NETWORK',
    );
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* bukan JSON */ }
  if (!res.ok) {
    const msg = res.status === 401 ? 'API key MyCalendar salah atau belum diisi (CALENDAR_API_KEY)' : (data && data.error) || `HTTP ${res.status}`;
    throw new CalendarClientError(msg, res.status, data && data.code);
  }
  return data;
}

// ─── Status ──────────────────────────────────────────────────────────────────
export const getStatus = () => request('GET', '/status');

// ─── Agenda & Konflik ────────────────────────────────────────────────────────
export const getAgenda = (from, to, includeNews = true) => request('GET', '/agenda', { query: { from, to, news: includeNews ? '1' : '0' } });
export const checkConflicts = (kind, data) => request('POST', '/conflicts/check', { body: { kind, data } });

// ─── Mata Kuliah (Courses) ───────────────────────────────────────────────────
export const listCourses = () => request('GET', '/courses');
export const getCourse = (id) => request('GET', `/courses/${id}`);
export const createCourse = (data) => request('POST', '/courses', { body: data });
export const updateCourse = (id, data) => request('PUT', `/courses/${id}`, { body: data });
export const deleteCourse = (id) => request('DELETE', `/courses/${id}`);

// ─── Pengecualian Kuliah (Course Exceptions: cancel, reschedule, exam) ────────
export const setCourseException = (courseId, date, data) => request('PUT', `/courses/${courseId}/exceptions/${date}`, { body: data });
export const deleteCourseException = (courseId, date) => request('DELETE', `/courses/${courseId}/exceptions/${date}`);

// ─── Jadwal & Acara (Events) ─────────────────────────────────────────────────
export const listEvents = () => request('GET', '/events');
export const getEvent = (id) => request('GET', `/events/${id}`);
export const createEvent = (data) => request('POST', '/events', { body: data });
export const updateEvent = (id, data) => request('PUT', `/events/${id}`, { body: data });
export const deleteEvent = (id) => request('DELETE', `/events/${id}`);

// ─── Berita Ekonomi USD ──────────────────────────────────────────────────────
export const getNews = (from, to) => request('GET', '/news', { query: { from, to } });
export const refreshNews = (force = false) => request('POST', '/news/refresh', { body: { force } });
export const getNewsStatus = () => request('GET', '/news/status');
export const verifyNews = (id) => request('POST', `/news/${id}/verify`);

// ─── Pengingat (Reminders) ───────────────────────────────────────────────────
export const getRemindersDue = (limit = 20) => request('GET', '/reminders/due', { query: { limit } });
export const ackReminders = (items) => request('POST', '/reminders/ack', { body: { items } });
export const listReminders = () => request('GET', '/reminders');

// ─── Pengaturan (Settings) ───────────────────────────────────────────────────
export const getSettings = () => request('GET', '/settings');
export const updateSettings = (data) => request('PUT', '/settings', { body: data });
