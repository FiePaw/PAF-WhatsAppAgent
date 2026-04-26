// plugins/agent.js
// Semua command ini HANYA bisa diakses owner
import { checkHealth } from '../services/aiService.js';
import { sessionStore } from '../services/sessionStore.js';
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
        const activeSessions = sessionStore.list().length;

        let text = `📊 *Status Bot*\n\n`;
        text += `🤖 Bot: ✅ Online\n`;
        text += `⏱️ Uptime: ${uptime}\n`;
        text += `🌐 AI Server: ${healthy ? '✅ Online' : '❌ Offline'}\n`;
        text += `💬 Active Sessions: ${activeSessions}\n`;
        text += `🔑 Owner: ${config.ownerNumber}\n`;
        text += `🔧 AI Model: ${config.ai.model}\n`;
        text += `🌍 API URL: ${config.ai.baseUrl}`;

        await reply(text);
        break;
      }

      // ── !sessions ──────────────────────────────────────────────────────
      case 'sessions': {
        const list = sessionStore.list();
        if (list.length === 0) {
          await reply('📭 Tidak ada session aktif saat ini.');
          return;
        }

        let text = `📋 *Active Sessions (${list.length})*\n\n`;
        list.forEach((s, i) => {
          text += `${i + 1}. \`${s.jid.split('@')[0]}\`\n`;
          text += `   ID: \`${s.sessionId}\`\n`;
          text += `   Last: ${s.lastUsed}\n\n`;
        });

        await reply(text);
        break;
      }

      // ── !clearsessions ─────────────────────────────────────────────────
      case 'clearsessions': {
        sessionStore.clear();
        await reply('🗑️ Semua session berhasil dihapus.');
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
