// plugins/persona.js
// Owner-only: manage persona per user langsung dari WhatsApp
import {
  getPersona,
  setPersona,
  deletePersona,
  setGlobalPersona,
  listPersonas,
} from '../services/personaService.js';
import { resetSession } from '../services/aiService.js';
import config from '../config/config.js';

const plugin = {
  name: 'Persona Manager',
  description: 'Kelola persona AI per user',
  commands: ['persona'],
  ownerOnly: true,

  handler: async ({ args, fullArgs, reply }) => {
    const sub = args[0]?.toLowerCase();
    const prefix = config.botPrefix;

    // ── !persona help ────────────────────────────────────────────────────
    if (!sub || sub === 'help') {
      let text = `🎭 *Persona Manager*\n\n`;
      text += `*Subcommand:*\n`;
      text += `• \`${prefix}persona list\` — Lihat semua persona\n`;
      text += `• \`${prefix}persona get [nomor]\` — Lihat persona user\n`;
      text += `• \`${prefix}persona set [nomor] [teks]\` — Set persona user\n`;
      text += `• \`${prefix}persona del [nomor]\` — Hapus persona user (kembali ke default)\n`;
      text += `• \`${prefix}persona setowner [teks]\` — Update persona owner\n`;
      text += `• \`${prefix}persona setdefault [teks]\` — Update persona default\n\n`;
      text += `_Contoh nomor: 628111222333_\n`;
      text += `_Perubahan langsung aktif tanpa restart bot._`;
      await reply(text);
      return;
    }

    // ── !persona list ────────────────────────────────────────────────────
    if (sub === 'list') {
      const data = listPersonas();
      const userKeys = Object.keys(data.users);

      let text = `🎭 *Daftar Persona*\n\n`;
      text += `👑 *Owner:*\n${data.owner.slice(0, 100)}${data.owner.length > 100 ? '...' : ''}\n\n`;
      text += `👤 *Default:*\n${data.default.slice(0, 100)}${data.default.length > 100 ? '...' : ''}\n\n`;

      if (userKeys.length === 0) {
        text += `📭 Belum ada persona spesifik per user.`;
      } else {
        text += `📋 *Per User (${userKeys.length}):*\n`;
        userKeys.forEach((k) => {
          const p = data.users[k];
          text += `• \`${k}\`: ${p.slice(0, 60)}${p.length > 60 ? '...' : ''}\n`;
        });
      }

      await reply(text);
      return;
    }

    // ── !persona get [nomor] ─────────────────────────────────────────────
    if (sub === 'get') {
      const number = args[1];
      if (!number) { await reply(`❓ Gunakan: \`${prefix}persona get [nomor]\``); return; }

      const fakeJid = `${number}@s.whatsapp.net`;
      const persona = getPersona(fakeJid, false);
      await reply(`🎭 Persona untuk \`${number}\`:\n\n${persona}`);
      return;
    }

    // ── !persona set [nomor] [teks] ──────────────────────────────────────
    if (sub === 'set') {
      const number = args[1];
      const personaText = args.slice(2).join(' ');
      if (!number || !personaText) {
        await reply(`❓ Gunakan: \`${prefix}persona set [nomor] [teks persona]\``);
        return;
      }

      const fakeJid = `${number}@s.whatsapp.net`;
      setPersona(fakeJid, personaText);

      // Reset session user agar pesan pertama berikutnya pakai persona baru
      await resetSession(fakeJid);

      await reply(`✅ Persona untuk \`${number}\` diperbarui.\nSession AI user direset agar persona baru aktif.`);
      return;
    }

    // ── !persona del [nomor] ─────────────────────────────────────────────
    if (sub === 'del' || sub === 'delete') {
      const number = args[1];
      if (!number) { await reply(`❓ Gunakan: \`${prefix}persona del [nomor]\``); return; }

      const fakeJid = `${number}@s.whatsapp.net`;
      const deleted = deletePersona(fakeJid);

      if (deleted) {
        await resetSession(fakeJid);
        await reply(`🗑️ Persona untuk \`${number}\` dihapus. User akan pakai persona default.`);
      } else {
        await reply(`⚠️ Tidak ada persona spesifik untuk \`${number}\`.`);
      }
      return;
    }

    // ── !persona setowner [teks] ─────────────────────────────────────────
    if (sub === 'setowner') {
      const personaText = args.slice(1).join(' ');
      if (!personaText) { await reply(`❓ Gunakan: \`${prefix}persona setowner [teks persona]\``); return; }

      setGlobalPersona('owner', personaText);
      await reply(`✅ Persona owner diperbarui.\n\n_Aktif di session AI berikutnya (ketik \`${prefix}reset\` untuk apply sekarang)._`);
      return;
    }

    // ── !persona setdefault [teks] ───────────────────────────────────────
    if (sub === 'setdefault') {
      const personaText = args.slice(1).join(' ');
      if (!personaText) { await reply(`❓ Gunakan: \`${prefix}persona setdefault [teks persona]\``); return; }

      setGlobalPersona('default', personaText);
      await reply(`✅ Persona default diperbarui.\n\n_Aktif di session AI baru. User yang sudah punya session aktif perlu \`${prefix}reset\` terlebih dahulu._`);
      return;
    }

    await reply(`❓ Subcommand tidak dikenal. Ketik \`${prefix}persona help\` untuk bantuan.`);
  },
};

export default plugin;