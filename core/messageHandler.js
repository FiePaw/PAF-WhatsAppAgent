// core/messageHandler.js
import config from '../config/config.js';
import { isOwner, isCommand, parseCommand } from '../utils/helpers.js';
import { typingDelay } from '../utils/delay.js';
import { askAI } from '../services/aiService.js';
import { getPersona } from '../services/personaService.js';
import { handleTriggeredPlugin } from './triggeredPluginHandler.js';
import { getGroupChannel } from '../services/groupService.js';
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

  const sender = msg.key.participant || jid;
  const owner = isOwner(sender);
  const isGroup = jid.endsWith('@g.us');

  // Helper untuk reply dengan typing delay anti-spam
  const reply = async (replyText) => {
    await typingDelay(sock, jid, replyText);
    await sock.sendMessage(jid, { text: replyText }, { quoted: msg });
  };

  logger.info(
    { jid, sender: sender.split('@')[0], owner, isGroup, text: text.slice(0, 60) },
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
    const groupCtx = { sock, msg, jid, sender, isOwner: owner, text, reply, groupChannel: channel };
    const groupSystemPrompt = getPersona(sender, owner);

    const [intentHandled, groupAiReply] = await Promise.all([
      // Intent detection hanya jika grup punya input channel
      channel.input
        ? handleTriggeredPlugin(groupCtx)
        : Promise.resolve(false),
      askAI({ jid: sender, userText: text, systemPrompt: groupSystemPrompt }).catch((err) => {
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
    const ctx = { sock, msg, jid, sender, isOwner: owner, text, reply };
    const systemPrompt = getPersona(sender, owner);

    const [intentHandled, aiReply] = await Promise.all([
      handleTriggeredPlugin(ctx),
      askAI({ jid: sender, userText: text, systemPrompt }).catch((err) => {
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
  const systemPrompt = getPersona(sender, owner);

  try {
    const aiReply = await askAI({ jid: sender, userText: text, systemPrompt });
    await reply(aiReply);
  } catch (err) {
    logger.error({ sender, err: err.message }, 'Error saat request ke AI');
    await reply('❌ Maaf, terjadi kesalahan. Coba lagi nanti.');
  }
}