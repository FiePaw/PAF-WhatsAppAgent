// services/cronService.js
// Lightweight cron/task scheduler for plugins and internal bot tasks.
// Supports: register named jobs, start/stop individual jobs, list active jobs.
//
// Usage in a plugin:
//   import cronService from '../services/cronService.js';
//   cronService.register('myJob', '*/5 * * * *', async () => { ... });
//   cronService.start('myJob');
//
// Cron expression format (standard 5-field):
//   * * * * *
//   │ │ │ │ └── day of week (0-7, 0 and 7 = Sunday)
//   │ │ │ └──── month (1-12)
//   │ │ └────── day of month (1-31)
//   │ └──────── hour (0-23)
//   └────────── minute (0-59)
//
// Special aliases: @hourly, @daily, @weekly, @monthly, @yearly, @every_<seconds>s

import logger from '../utils/logger.js';

// ─── Cron parser ──────────────────────────────────────────────────────────

const ALIASES = {
  '@hourly':  '0 * * * *',
  '@daily':   '0 0 * * *',
  '@weekly':  '0 0 * * 0',
  '@monthly': '0 0 1 * *',
  '@yearly':  '0 0 1 1 *',
};

function parseExpression(expr) {
  // Handle @every_<n>s shorthand (interval in seconds)
  const everyMatch = expr.match(/^@every_(\d+)s$/);
  if (everyMatch) {
    return { intervalMs: parseInt(everyMatch[1]) * 1000 };
  }

  // Resolve aliases
  const resolved = ALIASES[expr] || expr;
  const parts = resolved.split(/\s+/);
  if (parts.length !== 5) throw new Error(`Invalid cron expression: "${expr}"`);

  const [minute, hour, dom, month, dow] = parts;
  return { minute, hour, dom, month, dow };
}

function matchField(value, now) {
  if (value === '*') return true;
  // Handle */n step
  if (value.startsWith('*/')) {
    const step = parseInt(value.slice(2));
    return now % step === 0;
  }
  // Handle comma-separated list
  if (value.includes(',')) {
    return value.split(',').some((v) => parseInt(v) === now);
  }
  // Handle range (e.g. 1-5)
  if (value.includes('-')) {
    const [start, end] = value.split('-').map(Number);
    return now >= start && now <= end;
  }
  return parseInt(value) === now;
}

function shouldRunNow(parsed) {
  if (parsed.intervalMs) return false; // interval jobs are handled separately
  const now = new Date();
  return (
    matchField(parsed.minute, now.getMinutes()) &&
    matchField(parsed.hour, now.getHours()) &&
    matchField(parsed.dom, now.getDate()) &&
    matchField(parsed.month, now.getMonth() + 1) &&
    matchField(parsed.dow, now.getDay())
  );
}

// ─── Job Registry ─────────────────────────────────────────────────────────

class CronService {
  constructor() {
    // Map<name, { expr, parsed, fn, timer, running, lastRun, runCount }>
    this._jobs = new Map();
    this._ticker = null; // master 1-minute tick
    this._tickerInterval = null;
  }

  /**
   * Register a cron job. Does NOT start it automatically.
   * @param {string} name - unique job name
   * @param {string} expr - cron expression or alias
   * @param {Function} fn - async function to run
   * @param {object} [opts]
   * @param {boolean} [opts.autoStart=false] - start immediately after register
   * @param {boolean} [opts.runOnRegister=false] - run once immediately on register
   */
  register(name, expr, fn, opts = {}) {
    if (this._jobs.has(name)) {
      logger.warn({ name }, '⚠️ Cron job sudah terdaftar, overwrite');
      this.stop(name);
    }

    let parsed;
    try {
      parsed = parseExpression(expr);
    } catch (err) {
      logger.error({ name, expr, err: err.message }, '❌ Cron expression tidak valid');
      return;
    }

    this._jobs.set(name, {
      name,
      expr,
      parsed,
      fn,
      timer: null,
      running: false,
      lastRun: null,
      runCount: 0,
    });

    logger.info({ name, expr }, '📅 Cron job terdaftar');

    if (opts.runOnRegister) {
      this._execute(name).catch(() => {});
    }

    if (opts.autoStart) {
      this.start(name);
    }
  }

  /**
   * Start a registered job.
   * @param {string} name
   */
  start(name) {
    const job = this._jobs.get(name);
    if (!job) {
      logger.warn({ name }, '⚠️ Cron job tidak ditemukan');
      return;
    }
    if (job.running) return; // already running

    job.running = true;

    if (job.parsed.intervalMs) {
      // Interval-based job
      job.timer = setInterval(() => this._execute(name), job.parsed.intervalMs);
      logger.info({ name, intervalMs: job.parsed.intervalMs }, '▶️ Interval job started');
    } else {
      // Cron-based job — needs the master ticker
      this._ensureMasterTicker();
      logger.info({ name, expr: job.expr }, '▶️ Cron job started');
    }
  }

  /**
   * Stop a running job.
   * @param {string} name
   */
  stop(name) {
    const job = this._jobs.get(name);
    if (!job) return;
    if (job.timer) {
      clearInterval(job.timer);
      job.timer = null;
    }
    job.running = false;
    logger.info({ name }, '⏹️ Cron job stopped');
    this._stopMasterTickerIfIdle();
  }

  /**
   * Start all registered jobs.
   */
  startAll() {
    for (const name of this._jobs.keys()) this.start(name);
  }

  /**
   * Stop all running jobs.
   */
  stopAll() {
    for (const name of this._jobs.keys()) this.stop(name);
  }

  /**
   * Remove a job entirely.
   * @param {string} name
   */
  unregister(name) {
    this.stop(name);
    this._jobs.delete(name);
    logger.info({ name }, '🗑️ Cron job dihapus');
  }

  /**
   * List all jobs with their status.
   * @returns {object[]}
   */
  list() {
    return Array.from(this._jobs.values()).map(({ name, expr, running, lastRun, runCount }) => ({
      name,
      expr,
      running,
      lastRun,
      runCount,
    }));
  }

  // ─── Internal ─────────────────────────────────────────────────────────

  async _execute(name) {
    const job = this._jobs.get(name);
    if (!job) return;
    try {
      logger.debug({ name }, '⚙️ Running cron job');
      await job.fn();
      job.lastRun = new Date().toISOString();
      job.runCount++;
    } catch (err) {
      logger.error({ name, err: err.message }, '❌ Error dalam cron job');
    }
  }

  _ensureMasterTicker() {
    if (this._tickerInterval) return;
    // Tick at the start of every minute
    const msUntilNextMinute = (60 - new Date().getSeconds()) * 1000 - new Date().getMilliseconds();
    this._ticker = setTimeout(() => {
      this._tick();
      this._tickerInterval = setInterval(() => this._tick(), 60 * 1000);
    }, msUntilNextMinute);
  }

  _tick() {
    for (const [name, job] of this._jobs.entries()) {
      if (!job.running || job.parsed.intervalMs) continue;
      if (shouldRunNow(job.parsed)) {
        this._execute(name).catch(() => {});
      }
    }
  }

  _stopMasterTickerIfIdle() {
    const hasCronJobs = Array.from(this._jobs.values()).some(
      (j) => j.running && !j.parsed.intervalMs
    );
    if (!hasCronJobs) {
      if (this._ticker) { clearTimeout(this._ticker); this._ticker = null; }
      if (this._tickerInterval) { clearInterval(this._tickerInterval); this._tickerInterval = null; }
    }
  }
}

// Singleton
const cronService = new CronService();
export default cronService;