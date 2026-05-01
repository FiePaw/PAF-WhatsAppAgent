// core/bot.js
import {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import qrcode from 'qrcode-terminal';
import { loadPlugins } from './pluginLoader.js';
import { handleMessage } from './messageHandler.js';
import { initOwnerIntentSession } from '../services/intentSessionService.js';
import { warmupOwnerSession } from '../services/aiService.js';
import { getPersona } from '../services/personaService.js';
import cronService from '../services/cronService.js';
import config from '../config/config.js';
import logger from '../utils/logger.js';

// Suppress semua Baileys internal logs (termasuk Timed Out fetchProps, dll)
const baileysLogger = {
  level: 'silent',
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  fatal: () => {},
  child: () => baileysLogger,
};

export async function startBot() {
  // Load plugins sebelum koneksi
  const plugins = await loadPlugins();

  // Auth state (multi-file, QR login)
  const { state, saveCreds } = await useMultiFileAuthState(config.authDir);

  // Versi WA terbaru
  const { version } = await fetchLatestBaileysVersion();
  logger.info({ version }, '🔄 WA version');

  const sock = makeWASocket({
    version,
    logger: baileysLogger,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, baileysLogger),
    },
    printQRInTerminal: false,
    generateHighQualityLinkPreview: false,
    markOnlineOnConnect: config.markOnline,
  });

  // ─── QR Code ──────────────────────────────────────────────────────────────
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log('\n🔐 Scan QR Code berikut dengan WhatsApp:\n');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'close') {
      const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

      logger.warn({ statusCode, shouldReconnect }, '❌ Koneksi terputus');

      // Stop all cron jobs on disconnect
      cronService.stopAll();

      if (shouldReconnect) {
        logger.info('🔁 Mencoba reconnect...');
        setTimeout(() => startBot(), 5000);
      } else {
        logger.error('🚪 Logged out. Hapus folder auth/session dan scan ulang QR.');
        process.exit(1);
      }
    }

    if (connection === 'open') {
      logger.info('✅ Bot terhubung ke WhatsApp!');

      // ── Resolve LID owner jika belum diset dari .env ──────────────────────
      if (!config.ownerLid) {
        try {
          const [result] = await sock.onWhatsApp(config.ownerJid);
          if (result?.exists && result.jid) {
            config.ownerLid = result.jid;
            logger.info({ ownerLid: result.jid }, '👑 Owner LID berhasil di-resolve');
          } else {
            logger.warn(
              `⚠️  Owner LID tidak bisa di-resolve otomatis.\n` +
              `   → Kirim pesan apapun dari nomor owner, lalu salin angka dari log "sender"\n` +
              `   → Tambahkan ke .env: OWNER_LID=<angka tersebut>`
            );
          }
        } catch {
          logger.warn(
            `⚠️  Gagal resolve owner LID. Kirim pesan dari nomor owner,\n` +
            `   salin nilai "sender" dari log, lalu isi OWNER_LID di .env`
          );
        }
      } else {
        logger.info({ ownerLid: config.ownerLid }, '👑 Owner LID dimuat dari .env');
      }

      // ── Set status online jika dikonfigurasi ──────────────────────────────
      if (config.markOnline) {
        await sock.sendPresenceUpdate('available');
        logger.info('🟢 Status: Online');
      }

      // ── Init intent session untuk owner ───────────────────────────────────
      // Session persisten di Qwen untuk deteksi intent setiap pesan owner
      await initOwnerIntentSession();

      // ── Warmup owner AI session dengan persona ────────────────────────────
      // Persona owner dikirim ke Qwen saat bot start sehingga sesi AI
      // sudah punya konteks persona sejak percakapan pertama.
      const ownerJid = config.ownerLid || config.ownerJid;
      if (ownerJid) {
        const ownerPersona = getPersona(ownerJid, true);
        if (ownerPersona) {
          await warmupOwnerSession(ownerJid, ownerPersona);
        }
      }

      // ── Start semua cron job yang sudah di-register plugins ───────────────
      cronService.startAll();
      logger.info('📅 Semua cron job dijalankan');
    }
  });

  // ─── Simpan kredensial setiap update ─────────────────────────────────────
  sock.ev.on('creds.update', saveCreds);

  // ─── Handle pesan masuk ──────────────────────────────────────────────────
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      try {
        // Auto read receipt → centang biru
        if (config.autoRead && !msg.key.fromMe) {
          await sock.readMessages([msg.key]);
        }
        await handleMessage(sock, msg, plugins);
      } catch (err) {
        logger.error({ err: err.message }, 'Unhandled error di handleMessage');
      }
    }
  });

  return sock;
}