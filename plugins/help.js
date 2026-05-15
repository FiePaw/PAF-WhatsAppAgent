// plugins/help.js
import config from '../config/config.js';
import { isOwner } from '../utils/helpers.js';

const plugin = {
  name: 'Help',
  description: 'Tampilkan daftar command yang tersedia',
  commands: ['help', 'menu'],
  ownerOnly: false,

  handler: async ({ reply, isOwner: owner }) => {
    const prefix = config.botPrefix;

    let text = `🤖 *${config.botName} Bot*\n\n`;
    text += `📋 *Command Tersedia:*\n\n`;

    text += `*📌 Umum*\n`;
    text += `• \`${prefix}help\` — Tampilkan menu ini\n`;
    text += `• \`${prefix}ai [pertanyaan]\` — Tanya AI langsung\n`;
    text += `• \`${prefix}reset\` — Reset percakapan AI kamu\n\n`;

    if (owner) {
      text += `*👑 Owner Only*\n`;
      text += `• \`${prefix}status\` — Status bot & AI server\n`;
      text += `• \`${prefix}sessions\` — Lihat session aktif\n`;
      text += `• \`${prefix}clearsessions\` — Bersihkan semua session\n`;
      text += `• \`${prefix}broadcast [pesan]\` — Broadcast (kirim ke... belum impl)\n\n`;
    }

    text += `💬 *Chat Biasa*\nKirim pesan biasa (tanpa prefix) untuk chat dengan AI.\n\n`;
    text += `_Bot ini menggunakan Qwen AI_ ✨`;

    await reply(text);
  },
};

export default plugin;
