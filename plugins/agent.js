// plugins/agent.js
// Semua command ini HANYA bisa diakses owner
import { checkHealth, resetSession } from '../services/aiService.js';
import { sessionStore } from '../services/sessionStore.js';
import { listIntentSessions } from '../services/intentSessionService.js';
import { getMemories, getRecentSummaries, summarizeAndRemember } from '../services/memoryService.js';
import { formatUptime } from '../utils/helpers.js';
import config from '../config/config.js';

const BOT_START = Date.now();

const plugin = {
  name: 'Agent (Owner Only)',
  description: 'Command khusus owner untuk manage bot',
  commands: ['status', 'sessions', 'clearsessions', 'ping', 'memories', 'remember'],
  ownerOnly: true,

  handler: async ({ command, sender, reply }) => {
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
        text += `🔧 Chat Model: ${config.ai.chatModel}\n`;
        text += `🔧 Task Model: ${config.ai.taskModel}\n`;
        text += `🌍 API URL: ${config.ai.baseUrl || '(belum diset)'}`;

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

      // ── !memories — lihat isi Memory Bank untuk sender saat ini ─────
      case 'memories': {
        const facts = getMemories(sender);
        const summaries = getRecentSummaries(sender, 3);

        if (facts.length === 0 && summaries.length === 0) {
          await reply(
            '📭 Memory Bank untuk kamu masih kosong.\n\n' +
            '_Ini normal jika belum ada sesi yang berakhir (TTL 24 jam) atau belum pernah dipakai `!remember`. ' +
            'Gunakan `!remember` untuk bootstrap sekarang dari riwayat chat yang sudah ada._'
          );
          return;
        }

        let memText = `🧠 *Memory Bank kamu*\n\n`;
        if (summaries.length > 0) {
          memText += `*Ringkasan sesi terakhir (${summaries.length}):*\n`;
          summaries.forEach((s, i) => { memText += `${i + 1}. ${s.summary} _(${s.reason})_\n`; });
          memText += '\n';
        }
        if (facts.length > 0) {
          memText += `*Fakta tersimpan (${facts.length}):*\n`;
          facts.forEach((f, i) => { memText += `${i + 1}. [${f.category}·${f.importance}] ${f.fact}\n`; });
        }
        memText += `\n_Blok ini yang diinjeksi ke system prompt saat sesi BARU dimulai (bukan sesi yang sedang berjalan)._`;

        await reply(memText.trim());
        break;
      }

      // ── !remember — bootstrap Memory Bank SEKARANG + reset sesi ─────
      // Berguna saat Memory Bank masih kosong (baru deploy, atau sesi
      // saat ini sudah berjalan lama sebelum ada fakta baru tersimpan) —
      // tidak perlu menunggu TTL 24 jam. Setelah ini, kirim pesan apapun
      // lagi dan sesi baru akan otomatis membawa memori yang baru di-capture.
      case 'remember': {
        await reply('🔧 Meringkas riwayat chat & mengekstrak fakta penting sekarang...');

        await summarizeAndRemember(sender, 'manual');
        await resetSession(sender);

        const newFacts = getMemories(sender);
        const newSummaries = getRecentSummaries(sender, 1);

        let rememberText = `✅ Memory Bank diperbarui & sesi chat direset.\n\n`;
        if (newSummaries.length > 0) rememberText += `📝 Ringkasan baru: ${newSummaries[0].summary}\n\n`;
        if (newFacts.length > 0) {
          rememberText += `🧠 Total fakta tersimpan sekarang: ${newFacts.length}\n`;
          rememberText += newFacts.slice(0, 5).map((f) => `  • ${f.fact}`).join('\n');
        } else {
          rememberText += '⚠️ Tidak ada fakta baru terekstrak (riwayat chat mungkin terlalu pendek/generik).';
        }
        rememberText += `\n\n_Kirim pesan apapun sekarang — sesi baru akan langsung membawa memori ini._`;

        await reply(rememberText);
        break;
      }

      default:
        await reply('❓ Command agent tidak dikenal.');
    }
  },
};

export default plugin;