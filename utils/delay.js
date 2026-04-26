// utils/delay.js
import config from '../config/config.js';

/**
 * Hitung delay berdasarkan panjang teks (simulasi manusia mengetik)
 * @param {string} text
 * @returns {number} delay dalam ms
 */
export function calcTypingDelay(text) {
  const { charDelayMs, maxDelayMs } = config.antispam;
  if (!charDelayMs) return 0;
  const delay = Math.min(text.length * charDelayMs, maxDelayMs);
  return delay;
}

/**
 * Sleep helper
 * @param {number} ms
 */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Delay sambil kirim typing indicator, lalu resolve
 * @param {object} sock - Baileys socket
 * @param {string} jid
 * @param {string} text - teks yang akan dikirim (untuk hitung delay)
 */
export async function typingDelay(sock, jid, text) {
  const delay = calcTypingDelay(text);
  if (delay <= 0) return;

  await sock.sendPresenceUpdate('composing', jid);
  await sleep(delay);
  await sock.sendPresenceUpdate('paused', jid);
}
