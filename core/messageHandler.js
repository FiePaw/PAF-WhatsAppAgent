// core/messageHandler.js
import { downloadMediaMessage } from '@whiskeysockets/baileys';
import config from '../config/config.js';
import { isOwner, isCommand, parseCommand } from '../utils/helpers.js';
import { typingDelay } from '../utils/delay.js';
import { askAI } from '../services/aiService.js';
import { getPersona } from '../services/personaService.js';
import { handleTriggeredPlugin } from './triggeredPluginHandler.js';
import { getGroupChannel, getGroupPersona } from '../services/groupService.js';
import logger from '../utils/logger.js';

/**
 * Ekstrak gambar dari pesan WhatsApp dan convert ke format attachment untuk aiService.
 * Return null jika pesan bukan gambar atau gagal download.
 *
 * @param {object} sock
 * @param {object} msg
 * @returns {Promise<Array|null>} attachments array atau null
 */
async function extractImageAttachment(sock, msg) {
  const imageMsg = msg.message?.imageMessage;
  if (!imageMsg) return null;

  try {
    const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage });
    const base64 = buffer.toString('base64');
    const mimeType = imageMsg.mimetype || 'image/jpeg';
    const filename = `image_${Date.now()}.${mimeType.split('/')[1] || 'jpg'}`;

    logger.debug({ filename, mimeType, size: buffer.length }, '🖼️ Gambar berhasil di-download');

    return [{ filename, data: base64, mime_type: mimeType }];
  } catch (err) {
    logger.error({ err: err.message }, '❌ Gagal download gambar dari pesan');
    return null;
  }
}

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

  // ── Deteksi tipe pesan ────────────────────────────────────────────────────
  const hasImage = !!msg.message?.imageMessage;

  // Ambil teks pesan (caption jika gambar)
  const text =
    msg.message?.conversation ||
    msg.message?.extendedTextMessage?.text ||
    msg.message?.imageMessage?.caption ||
    msg.message?.videoMessage?.caption ||
    '';

  // Pesan tanpa teks dan tanpa gambar → abaikan
  if (!text.trim() && !hasImage) return;

  const sender = msg.key.participant || jid;
  const owner = isOwner(sender);
  const isGroup = jid.endsWith('@g.us');

  // ── Ekstrak gambar jika ada ───────────────────────────────────────────────
  // attachments = null jika bukan gambar, array jika ada gambar
  const attachments = hasImage ? await extractImageAttachment(sock, msg) : null;

  // Teks efektif untuk intent detection — placeholder jika gambar tanpa caption
  const intentText = text.trim() || (hasImage ? '[gambar dikirim]' : '');

  // Helper untuk reply dengan typing delay anti-spam
  const reply = async (replyText) => {
    await typingDelay(sock, jid, replyText);
    await sock.sendMessage(jid, { text: replyText }, { quoted: msg });
  };

  logger.info(
    { jid, sender: sender.split('@')[0], owner, isGroup, hasImage, text: text.slice(0, 60) },
    '📩 Pesan masuk'
  );

  // ─── Group Routing ───────────────────────────────────────────────────────
  // Semua grup terdaftar: owner bisa chat AI, command, dan intent detection.
  // Grup tidak terdaftar: semua pesan diabaikan.
  if (isGroup) {
    const channel = getGroupChannel(jid);

    // Grup tidak terdaftar → hanya izinkan !group register dari owner
    if (!channel) {
      if (!owner) return;
      if (isCommand(text)) {
        const { command, args, fullArgs } = parseCommand(text);
        if ((command === 'group' || command === 'grp') && args[0]?.toLowerCase() === 'register') {
          const plugin = plugins.get(command);
          if (plugin) {
            try {
              await plugin.handler({
                sock, msg, jid, sender,
                isOwner: owner, text, command, args, fullArgs, reply,
              });
            } catch (err) {
              logger.error({ command, jid, err: err.message }, 'Error di group register (unregistered group)');
              await reply('⚠️ Terjadi kesalahan saat mendaftarkan grup.');
            }
          }
        }
      }
      return;
    }

    // Hanya owner yang bisa berinteraksi di grup terdaftar
    if (!owner) return;

    // ── Command handler di grup ──────────────────────────────────────────
    if (isCommand(text)) {
      const { command, args, fullArgs } = parseCommand(text);
      const plugin = plugins.get(command);

      // Command tidak dikenal → diam saja di grup (tidak reply error)
      if (!plugin) return;

      try {
        await plugin.handler({
          sock, msg, jid, sender,
          isOwner: owner, text, command, args, fullArgs, reply,
          groupChannel: channel,
        });
      } catch (err) {
        logger.error({ command, jid, err: err.message }, 'Error di plugin handler (group)');
        await reply('⚠️ Terjadi kesalahan saat menjalankan command.');
      }
      return;
    }

    // ── Pesan natural owner di grup → intent detection + AI chat paralel ─
    const groupCtx = { sock, msg, jid, sender, isOwner: owner, text: intentText, reply, groupChannel: channel, attachments };
    // Persona grup dipakai jika ada, fallback ke persona owner
    const groupPersona = getGroupPersona(jid);
    const ownerPersonaObj = getPersona(sender, owner);
    const groupSystemPrompt = groupPersona || ownerPersonaObj.prompt;
    // Model: grup tidak punya model sendiri, pakai model dari persona owner sebagai fallback
    const groupModel = ownerPersonaObj.model;

    const [intentHandled, groupAiReply] = await Promise.all([
      // Intent detection hanya jika grup punya input channel
      channel.input
        ? handleTriggeredPlugin(groupCtx)
        : Promise.resolve(false),
      askAI({ jid: jid, userText: intentText, systemPrompt: groupSystemPrompt, attachments, model: groupModel }).catch((err) => {
        logger.error({ sender, jid, err: err.message }, 'Error saat request ke AI (group)');
        return null;
      }),
    ]);

    if (intentHandled) return;

    if (groupAiReply) {
      await reply(groupAiReply);
    } else {
      await reply('❌ Maaf, terjadi kesalahan. Coba lagi nanti.');
    }
    return;
  }

  // ─── Command Handler (DM) ────────────────────────────────────────────────
  if (isCommand(text)) {
    const { command, args, fullArgs } = parseCommand(text);
    const plugin = plugins.get(command);

    if (!plugin) {
      await reply(`❓ Command *${config.botPrefix}${command}* tidak dikenal.\nKetik *${config.botPrefix}help* untuk daftar command.`);
      return;
    }

    if (plugin.ownerOnly && !owner) {
      await reply('🔒 Command ini hanya untuk owner.');
      return;
    }

    try {
      await plugin.handler({ sock, msg, jid, sender, isOwner: owner, text, command, args, fullArgs, reply });
    } catch (err) {
      logger.error({ command, err: err.message }, 'Error di plugin handler');
      await reply('⚠️ Terjadi kesalahan saat menjalankan command.');
    }

    return;
  }

  // ─── Owner: intent detection + AI chat berjalan paralel ─────────────────
  if (owner) {
    const ctx = { sock, msg, jid, sender, isOwner: owner, text: intentText, reply, attachments };
    const { prompt: systemPrompt, model } = getPersona(sender, owner);

    const [intentHandled, aiReply] = await Promise.all([
      handleTriggeredPlugin(ctx),
      askAI({ jid: sender, userText: intentText, systemPrompt, attachments, model }).catch((err) => {
        logger.error({ sender, err: err.message }, 'Error saat request ke AI (parallel)');
        return null;
      }),
    ]);

    if (intentHandled) return;

    if (aiReply) {
      await reply(aiReply);
    } else {
      await reply('❌ Maaf, terjadi kesalahan. Coba lagi nanti.');
    }
    return;
  }

  // ─── Non-owner: AI chat saja ─────────────────────────────────────────────
  const { prompt: systemPrompt, model } = getPersona(sender, owner);

  try {
    const aiReply = await askAI({ jid: sender, userText: intentText, systemPrompt, attachments, model });
    await reply(aiReply);
  } catch (err) {
    logger.error({ sender, err: err.message }, 'Error saat request ke AI');
    await reply('❌ Maaf, terjadi kesalahan. Coba lagi nanti.');
  }
}