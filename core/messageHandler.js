// core/messageHandler.js
import config from '../config/config.js';
import { isOwner, isCommand, parseCommand } from '../utils/helpers.js';
import { typingDelay } from '../utils/delay.js';
import { askAI } from '../services/aiService.js';
import { getPersona } from '../services/personaService.js';
import logger from '../utils/logger.js';

/**
 * Handle setiap pesan masuk
 * @param {object} sock - Baileys socket
 * @param {object} msg  - Baileys message object
 * @param {Map}    plugins - Map<command, plugin>
 */
export async function handleMessage(sock, msg, plugins) {
  // Abaikan pesan dari diri sendiri
  if (msg.key.fromMe) return;

  const jid = msg.key.remoteJid;

  // Abaikan status broadcast
  if (jid === 'status@broadcast') return;

  // Ambil teks pesan
  const text =
    msg.message?.conversation ||
    msg.message?.extendedTextMessage?.text ||
    msg.message?.imageMessage?.caption ||
    msg.message?.videoMessage?.caption ||
    '';

  if (!text.trim()) return;

  const sender = msg.key.participant || jid; // participant untuk grup, jid untuk DM
  const owner = isOwner(sender);

  // Helper untuk reply dengan typing delay anti-spam
  const reply = async (replyText) => {
    await typingDelay(sock, jid, replyText);
    await sock.sendMessage(jid, { text: replyText }, { quoted: msg });
  };

  logger.info(
    { jid, sender: sender.split('@')[0], owner, text: text.slice(0, 60) },
    '📩 Pesan masuk'
  );

  // ─── Command Handler ────────────────────────────────────────────────────
  if (isCommand(text)) {
    const { command, args, fullArgs } = parseCommand(text);

    const plugin = plugins.get(command);

    if (!plugin) {
      await reply(`❓ Command *${config.botPrefix}${command}* tidak dikenal.\nKetik *${config.botPrefix}help* untuk daftar command.`);
      return;
    }

    // Cek akses: plugin ownerOnly hanya untuk owner
    if (plugin.ownerOnly && !owner) {
      await reply('🔒 Command ini hanya untuk owner.');
      return;
    }

    try {
      await plugin.handler({
        sock,
        msg,
        jid,
        sender,
        isOwner: owner,
        text,
        command,
        args,
        fullArgs,
        reply,
      });
    } catch (err) {
      logger.error({ command, err: err.message }, 'Error di plugin handler');
      await reply('⚠️ Terjadi kesalahan saat menjalankan command.');
    }

    return;
  }

  // ─── AI Chat Handler ─────────────────────────────────────────────────────
  const systemPrompt = getPersona(sender, owner);

  try {
    const aiReply = await askAI({ jid: sender, userText: text, systemPrompt });
    await reply(aiReply);
  } catch (err) {
    logger.error({ sender, err: err.message }, 'Error saat request ke AI');
    await reply('❌ Maaf, terjadi kesalahan. Coba lagi nanti.');
  }
}