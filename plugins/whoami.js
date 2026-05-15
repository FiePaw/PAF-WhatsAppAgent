// plugins/whoami.js
// Debug plugin — lihat JID kamu dan status owner
import config from '../config/config.js';

const plugin = {
  name: 'Who Am I',
  description: 'Debug: tampilkan JID dan status owner kamu',
  commands: ['whoami'],
  ownerOnly: false,

  handler: async ({ sender, jid, isOwner: owner, reply }) => {
    let text = `🔍 *Debug Info*\n\n`;
    text += `📱 Sender JID:\n\`${sender}\`\n\n`;
    text += `💬 Chat JID:\n\`${jid}\`\n\n`;
    text += `👑 Status: ${owner ? '*OWNER ✅*' : 'User biasa'}\n\n`;
    text += `─────────────────\n`;
    text += `⚙️ *Config Owner*\n`;
    text += `Nomor: \`${config.ownerNumber}\`\n`;
    text += `JID: \`${config.ownerJid}\`\n`;
    text += `LID: \`${config.ownerLid ?? 'belum di-resolve'}\`\n\n`;
    text += `_Jika kamu owner tapi status "User biasa",\ncopy Sender JID di atas dan set sebagai\nOWNER_LID di .env_`;

    await reply(text);
  },
};

export default plugin;
