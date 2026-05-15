// plugins/agent.js
// Semua command ini HANYA bisa diakses owner
import { checkHealth } from '../services/aiService.js';
import { sessionStore } from '../services/sessionStore.js';
import { listIntentSessions } from '../services/intentSessionService.js';
import { formatUptime } from '../utils/helpers.js';
import config from '../config/config.js';

const BOT_START = Date.now();

const plugin = {
  name: 'Agent (Owner Only)',
  description: 'Command khusus owner untuk manage bot',
  commands: ['status', 'sessions', 'clearsessions', 'ping'],
  ownerOnly: true,

  handler: async ({ command, reply }) => {
    switch (command) {

      // ── !status ────────────────────────────────────────────────────────
      case 'status': {
        const healthy = await checkHealth();
        const uptime = formatUptime(Date.now() - BOT_START);
        const chatSessions = sessionStore.list().length;
        const intentSessions = listIntentSessions().length;

        let text = `📊 *Status Bot*\n\n`;
        text += `🤖 Bot: ✅ Online\n`;
        text += `⏱️ Uptime: ${uptime}\n`;
        text += `🌐 AI Server: ${healthy ? '✅ Online' : '❌ Offline'}\n`;
        text += `💬 Chat Sessions: ${chatSessions}\n`;
        text += `🔍 Intent Sessions: ${intentSessions}\n`;
        text += `🔑 Owner: ${config.ownerNumber}\n`;
        text += `🔧 AI Model: ${config.ai.model}\n`;
        text += `🌍 API URL: ${config.ai.baseUrl}`;

        await reply(text);
        break;
      }

      // ── !sessions ──────────────────────────────────────────────────────
      case 'sessions': {
        const chatList = sessionStore.list();
        const intentList = listIntentSessions();

        if (chatList.length === 0 && intentList.length === 0) {
          await reply('📭 Tidak ada session aktif saat ini.');
          return;
        }

        let text = '';

        if (chatList.length > 0) {
          text += `💬 *Chat Sessions (${chatList.length})*\n\n`;
          chatList.forEach((s, i) => {
            text += `${i + 1}. \`${s.jid.split('@')[0]}\`\n`;
            text += `   ID: \`${s.sessionId}\`\n`;
            text += `   Last: ${s.lastUsed}\n\n`;
          });
        }

        if (intentList.length > 0) {
          text += `🔍 *Intent Sessions (${intentList.length})*\n\n`;
          intentList.forEach((s, i) => {
            text += `${i + 1}. \`${s.jid.split('@')[0]}\`\n`;
            text += `   ID: \`${s.sessionId}\`\n\n`;
          });
        }

        await reply(text.trim());
        break;
      }

      // ── !clearsessions ─────────────────────────────────────────────────
      case 'clearsessions': {
        sessionStore.clear();
        await reply('🗑️ Semua chat session berhasil dihapus.\n_Intent sessions tidak dihapus — dikelola otomatis oleh bot._');
        break;
      }

      // ── !ping ──────────────────────────────────────────────────────────
      case 'ping': {
        const start = Date.now();
        await checkHealth();
        const ms = Date.now() - start;
        await reply(`🏓 Pong! AI API latency: *${ms}ms*`);
        break;
      }

      default:
        await reply('❓ Command agent tidak dikenal.');
    }
  },
};

export default plugin;