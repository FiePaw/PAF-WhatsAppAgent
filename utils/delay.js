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

/**
 * Kirim array segmen satu per satu dengan composing indicator tiap segmen.
 * Dipakai oleh messageHandler, statusService, dan botBrain.
 *
 * Flow tiap segmen:
 *   1. sleep(delay detik)        ← jeda antar segmen (segmen pertama delay=0)
 *   2. sendPresenceUpdate composing
 *   3. sleep(calcTypingDelay)    ← simulasi mengetik sesuai panjang teks
 *   4. sendMessage
 *   5. sendPresenceUpdate paused
 *
 * @param {object} sock
 * @param {string} jid
 * @param {{ text: string, delay: number }[]} segments  — dari askAISegmented()
 * @param {object} [quotedMsg]   — pesan yang di-quote (opsional, hanya segmen pertama)
 * @returns {Promise<void>}
 */
export async function replySegmented(sock, jid, segments, quotedMsg = null) {
  for (let i = 0; i < segments.length; i++) {
    const { text, delay } = segments[i];

    // Jeda antar segmen (segmen pertama delay selalu 0 — langsung composing)
    if (delay > 0) {
      await sleep(delay * 1000);
    }

    // Composing indicator
    try {
      await sock.sendPresenceUpdate('composing', jid);
    } catch {
      // Presence update bisa gagal tanpa mengganggu pengiriman pesan
    }

    // Simulasi mengetik berdasarkan panjang teks
    const typingMs = calcTypingDelay(text);
    if (typingMs > 0) {
      await sleep(typingMs);
    }

    // Kirim pesan — hanya segmen pertama yang meng-quote pesan asli
    const sendOpts = i === 0 && quotedMsg ? { quoted: quotedMsg } : {};
    await sock.sendMessage(jid, { text }, sendOpts);

    // Paused setelah kirim
    try {
      await sock.sendPresenceUpdate('paused', jid);
    } catch {
      // ignore
    }
  }
}
