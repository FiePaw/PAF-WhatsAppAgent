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

const baseUrl = () => (process.env.CALENDAR_API_URL || 'http://127.0.0.1:9570').replace(/\/+$/, '');
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

export const getStatus = () => request('GET', '/status');
export const getAgenda = (from, to, includeNews = true) => request('GET', '/agenda', { query: { from, to, news: includeNews ? '1' : '0' } });
export const getNews = (from, to) => request('GET', '/news', { query: { from, to } });
export const refreshNews = (force = false) => request('POST', '/news/refresh', { body: { force } });
export const checkConflicts = (kind, data) => request('POST', '/conflicts/check', { body: { kind, data } });
export const listEvents = () => request('GET', '/events');
export const createEvent = (data) => request('POST', '/events', { body: data });
export const deleteEvent = (id) => request('DELETE', `/events/${id}`);
export const getRemindersDue = (limit = 20) => request('GET', '/reminders/due', { query: { limit } });
export const ackReminders = (items) => request('POST', '/reminders/ack', { body: { items } });
