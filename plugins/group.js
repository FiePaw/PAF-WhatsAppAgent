// plugins/group.js
// Plugin manajemen grup WhatsApp untuk owner.
//
// Commands:
//   !group create <nama>                   → Buat grup baru, owner otomatis dimasukkan
//   !group delete <groupJid>               → Bot keluar dan hapus grup dari daftar
//   !group list                            → Tampilkan semua grup terdaftar
//   !group register [nama]                 → Daftarkan grup ini (jika diketik di dalam grup)
//                                            atau: !group register <groupJid> <nama> (dari DM)
//   !group info [groupJid]                 → Detail grup, channel, dan persona aktif
//   !group channel <groupJid> <pluginKey> <input|output|both|none>
//                                          → Set grup sebagai channel plugin
//   !group persona [teks]                  → Set persona grup (diketik di dalam grup)
//                                            atau: !group persona clear → hapus persona grup
//                                            atau: !group persona <groupJid> [teks] (dari DM)

import {
  createGroup,
  deleteGroup,
  listGroups,
  registerGroup,
  setGroupChannel,
  setGroupPersona,
  findGroup,
} from '../services/groupService.js';
import { resetSession } from '../services/aiService.js';
import logger from '../utils/logger.js';

export default {
  name: 'group',
  description: 'Manajemen grup WhatsApp (buat, hapus, channel input/output, persona)',
  commands: ['group', 'grp'],
  ownerOnly: true,

  handler: async ({ sock, msg, jid, sender, text, command, args, fullArgs, reply }) => {
    const sub = args[0]?.toLowerCase();
    const fromGroup = jid.endsWith('@g.us');

    // ── !group (tanpa sub-command) → tampilkan help ──────────────────────
    if (!sub) {
      await reply(
        `📋 *Manajemen Grup*\n\n` +
        `*!group create* <nama>\n` +
        `  → Buat grup baru dan masukkan owner\n\n` +
        `*!group delete* <groupJid>\n` +
        `  → Bot keluar dan hapus grup dari daftar\n\n` +
        `*!group register* [nama]\n` +
        `  → Ketik di dalam grup untuk daftarkan grup itu langsung\n` +
        `  → Dari DM: !group register <groupJid> <nama>\n\n` +
        `*!group list*\n` +
        `  → Tampilkan semua grup terdaftar\n\n` +
        `*!group info* [groupJid]\n` +
        `  → Detail grup, channel, dan persona aktif\n\n` +
        `*!group channel* <groupJid> <pluginKey> <input|output|both|none>\n` +
        `  → Set grup sebagai channel input/output plugin\n\n` +
        `*!group persona* [teks]\n` +
        `  → Ketik di dalam grup: set persona khusus grup ini\n` +
        `  → !group persona clear → hapus persona grup (kembali ke persona owner)\n` +
        `  → Dari DM: !group persona <groupJid> [teks]\n\n` +
        `_Contoh pluginKey: reminder, broadcast, log_`
      );
      return;
    }

    // ── !group create <nama> ─────────────────────────────────────────────
    if (sub === 'create') {
      const groupName = args.slice(1).join(' ').trim();
      if (!groupName) {
        await reply('❓ Gunakan: *!group create* <nama grup>');
        return;
      }

      await reply(`⏳ Membuat grup *${groupName}*...`);

      try {
        const result = await createGroup(sock, groupName);
        if (!result.success) {
          await reply(`❌ Gagal membuat grup: ${result.error}`);
          return;
        }

        await reply(
          `✅ Grup berhasil dibuat!\n\n` +
          `📌 *Nama:* ${result.name}\n` +
          `🆔 *JID:* ${result.groupJid}\n\n` +
          `_Gunakan !group channel untuk mengatur channel plugin._\n` +
          `_Gunakan !group persona untuk mengatur persona AI grup ini._`
        );
      } catch (err) {
        logger.error({ err: err.message }, 'Error di group create');
        await reply('⚠️ Terjadi kesalahan saat membuat grup. Coba lagi nanti.');
      }
      return;
    }

    // ── !group delete <groupJid> ─────────────────────────────────────────
    if (sub === 'delete') {
      const groupJid = args[1]?.trim();
      if (!groupJid) {
        await reply('❓ Gunakan: *!group delete* <groupJid>\n_Gunakan !group list untuk melihat JID_');
        return;
      }

      const group = findGroup(groupJid);
      if (!group) {
        await reply(`❌ Grup dengan JID *${groupJid}* tidak ditemukan di daftar.`);
        return;
      }

      await reply(`⏳ Menghapus grup *${group.name}*...`);

      try {
        const result = await deleteGroup(sock, groupJid);
        if (!result.success) {
          await reply(`❌ Gagal menghapus grup: ${result.error}`);
          return;
        }
        await reply(`✅ Grup *${group.name}* berhasil dihapus dari daftar dan bot sudah keluar.`);
      } catch (err) {
        logger.error({ err: err.message }, 'Error di group delete');
        await reply('⚠️ Terjadi kesalahan saat menghapus grup.');
      }
      return;
    }

    // ── !group register ───────────────────────────────────────────────────
    // Dua mode:
    //   1. Diketik DI DALAM GRUP → auto-detect JID dan nama grup dari metadata
    //   2. Dari DM → manual: !group register <groupJid> <nama>
    if (sub === 'register') {
      if (fromGroup) {
        const groupJid = jid;
        let groupName = args.slice(1).join(' ').trim();

        if (!groupName) {
          try {
            const meta = await sock.groupMetadata(groupJid);
            groupName = meta?.subject || groupJid;
          } catch {
            groupName = groupJid;
          }
        }

        try {
          const result = await registerGroup(groupJid, groupName);
          if (!result.success) {
            await reply(`❌ ${result.error}`);
            return;
          }
          await reply(
            `✅ Grup ini berhasil didaftarkan!\n\n` +
            `📌 *Nama:* ${groupName}\n` +
            `🆔 *JID:* ${groupJid}\n\n` +
            `_Gunakan !group channel untuk mengatur channel plugin._\n` +
            `_Gunakan !group persona untuk mengatur persona AI grup ini._`
          );
        } catch (err) {
          logger.error({ err: err.message }, 'Error di group register (auto)');
          await reply('⚠️ Terjadi kesalahan saat mendaftarkan grup.');
        }
        return;
      }

      // Mode manual dari DM
      const groupJid = args[1]?.trim();
      const groupName = args.slice(2).join(' ').trim();

      if (!groupJid || !groupName) {
        await reply(
          '❓ Dari DM gunakan: *!group register* <groupJid> <nama grup>\n' +
          '_Atau ketik !group register langsung di dalam grup untuk daftarkan otomatis._'
        );
        return;
      }

      try {
        const result = await registerGroup(groupJid, groupName);
        if (!result.success) {
          await reply(`❌ ${result.error}`);
          return;
        }
        await reply(
          `✅ Grup berhasil didaftarkan!\n\n` +
          `📌 *Nama:* ${groupName}\n` +
          `🆔 *JID:* ${groupJid}`
        );
      } catch (err) {
        logger.error({ err: err.message }, 'Error di group register (manual)');
        await reply('⚠️ Terjadi kesalahan saat mendaftarkan grup.');
      }
      return;
    }

    // ── !group list ───────────────────────────────────────────────────────
    if (sub === 'list') {
      try {
        const groups = listGroups();
        if (!groups.length) {
          await reply('📋 Belum ada grup yang terdaftar.\n\nGunakan *!group create <nama>* untuk membuat grup baru.');
          return;
        }

        const lines = groups.map((g, i) => {
          const channels = Object.entries(g.channels || {});
          const channelInfo = channels.length
            ? channels.map(([k, v]) => `${k}:${v}`).join(', ')
            : 'tidak ada channel';
          const personaInfo = g.persona
            ? `_${g.persona.slice(0, 40)}${g.persona.length > 40 ? '...' : ''}_`
            : '_belum diset_';
          return (
            `${i + 1}. *${g.name}*\n` +
            `   JID: \`${g.groupJid}\`\n` +
            `   Channel: _${channelInfo}_\n` +
            `   Persona: ${personaInfo}`
          );
        });

        await reply(`📋 *Daftar Grup (${groups.length})*\n\n${lines.join('\n\n')}`);
      } catch (err) {
        logger.error({ err: err.message }, 'Error di group list');
        await reply('⚠️ Terjadi kesalahan saat mengambil daftar grup.');
      }
      return;
    }

    // ── !group info [groupJid] ────────────────────────────────────────────
    if (sub === 'info') {
      const groupJid = args[1]?.trim() || (fromGroup ? jid : null);

      if (!groupJid) {
        await reply('❓ Gunakan: *!group info* <groupJid>');
        return;
      }

      const group = findGroup(groupJid);
      if (!group) {
        await reply(`❌ Grup dengan JID *${groupJid}* tidak ditemukan.`);
        return;
      }

      const channels = Object.entries(group.channels || {});
      const channelLines = channels.length
        ? channels.map(([k, v]) => {
            const icon = v === 'input' ? '📥' : v === 'output' ? '📤' : '🔄';
            return `  ${icon} *${k}* → ${v}`;
          }).join('\n')
        : '  _Belum ada channel yang diset_';

      const personaLine = group.persona
        ? group.persona.slice(0, 120) + (group.persona.length > 120 ? '...' : '')
        : '_Belum diset — menggunakan persona owner_';

      await reply(
        `📌 *Info Grup*\n\n` +
        `Nama: *${group.name}*\n` +
        `JID: \`${group.groupJid}\`\n` +
        `Dibuat: ${group.createdAt}\n\n` +
        `*Channel:*\n${channelLines}\n\n` +
        `*Persona:*\n  ${personaLine}`
      );
      return;
    }

    // ── !group channel <groupJid> <pluginKey> <role> ──────────────────────
    if (sub === 'channel') {
      const groupJid = args[1]?.trim();
      const pluginKey = args[2]?.trim()?.toLowerCase();
      const role = args[3]?.trim()?.toLowerCase();

      if (!groupJid || !pluginKey || !role) {
        await reply(
          '❓ Gunakan: *!group channel* <groupJid> <pluginKey> <role>\n\n' +
          '*Role yang tersedia:*\n' +
          '  📥 *input* → grup hanya sebagai input\n' +
          '  📤 *output* → grup hanya sebagai output\n' +
          '  🔄 *both* → grup sebagai input dan output\n' +
          '  ❌ *none* → hapus channel ini dari grup\n\n' +
          '_Contoh: !group channel 120363xxx@g.us reminder both_'
        );
        return;
      }

      const validRoles = ['input', 'output', 'both', 'none'];
      if (!validRoles.includes(role)) {
        await reply(`❌ Role tidak valid. Pilih: *input*, *output*, *both*, atau *none*`);
        return;
      }

      const group = findGroup(groupJid);
      if (!group) {
        await reply(`❌ Grup dengan JID *${groupJid}* tidak ditemukan di daftar.\n_Daftarkan dulu dengan !group register_`);
        return;
      }

      try {
        const result = await setGroupChannel(groupJid, pluginKey, role);
        if (!result.success) {
          await reply(`❌ ${result.error}`);
          return;
        }

        const icon = role === 'input' ? '📥' : role === 'output' ? '📤' : role === 'both' ? '🔄' : '❌';
        const action = role === 'none' ? 'dihapus dari grup' : `diset ke ${role}`;

        await reply(
          `✅ Channel berhasil diperbarui!\n\n` +
          `📌 *Grup:* ${group.name}\n` +
          `🔑 *Plugin:* ${pluginKey}\n` +
          `${icon} *Role:* ${action}`
        );
      } catch (err) {
        logger.error({ err: err.message }, 'Error di group channel');
        await reply('⚠️ Terjadi kesalahan saat mengatur channel.');
      }
      return;
    }

    // ── !group persona ────────────────────────────────────────────────────
    // Tiga mode:
    //   1. Diketik DI DALAM GRUP: !group persona <teks> → set persona grup ini
    //   2. Diketik DI DALAM GRUP: !group persona clear  → hapus persona grup ini
    //   3. Dari DM: !group persona <groupJid> <teks>    → set persona grup tertentu
    //   4. Dari DM: !group persona <groupJid> clear     → hapus persona grup tertentu
    if (sub === 'persona') {
      if (fromGroup) {
        const groupJid = jid;
        const group = findGroup(groupJid);

        if (!group) {
          await reply('❌ Grup ini belum terdaftar.\nKetik *!group register* terlebih dahulu.');
          return;
        }

        const rest = args.slice(1).join(' ').trim();

        // Clear persona grup
        if (rest.toLowerCase() === 'clear' || !rest) {
          if (!rest) {
            // Tampilkan persona aktif jika tidak ada args
            const current = group.persona
              ? group.persona.slice(0, 200) + (group.persona.length > 200 ? '...' : '')
              : '_Belum diset — menggunakan persona owner_';
            await reply(
              `🎭 *Persona Grup: ${group.name}*\n\n${current}\n\n` +
              `_Gunakan !group persona <teks> untuk mengatur persona._\n` +
              `_Gunakan !group persona clear untuk menghapus persona grup._`
            );
            return;
          }

          try {
            await setGroupPersona(groupJid, null);
            // Reset session AI owner untuk grup ini agar persona baru aktif
            await resetSession(sender);
            await reply(
              `🗑️ Persona grup *${group.name}* dihapus.\n` +
              `_Bot akan menggunakan persona owner saat chat di grup ini._`
            );
          } catch (err) {
            logger.error({ err: err.message }, 'Error di group persona clear');
            await reply('⚠️ Terjadi kesalahan saat menghapus persona grup.');
          }
          return;
        }

        // Set persona grup
        try {
          await setGroupPersona(groupJid, rest);
          await resetSession(sender);
          await reply(
            `✅ Persona grup *${group.name}* berhasil diset!\n\n` +
            `_Persona ini akan aktif saat kamu chat di grup ini._\n` +
            `_Session AI direset agar persona baru langsung aktif._`
          );
        } catch (err) {
          logger.error({ err: err.message }, 'Error di group persona set (in-group)');
          await reply('⚠️ Terjadi kesalahan saat mengatur persona grup.');
        }
        return;
      }

      // Mode dari DM: !group persona <groupJid> [teks|clear]
      const groupJid = args[1]?.trim();
      if (!groupJid) {
        await reply(
          '❓ Gunakan:\n' +
          '  • Di dalam grup: *!group persona* <teks persona>\n' +
          '  • Di dalam grup: *!group persona clear* → hapus persona\n' +
          '  • Dari DM: *!group persona* <groupJid> <teks persona>\n' +
          '  • Dari DM: *!group persona* <groupJid> clear → hapus persona'
        );
        return;
      }

      const group = findGroup(groupJid);
      if (!group) {
        await reply(`❌ Grup dengan JID *${groupJid}* tidak ditemukan.\n_Daftarkan dulu dengan !group register_`);
        return;
      }

      const personaText = args.slice(2).join(' ').trim();

      // Tampilkan persona aktif jika tidak ada teks
      if (!personaText) {
        const current = group.persona
          ? group.persona.slice(0, 200) + (group.persona.length > 200 ? '...' : '')
          : '_Belum diset — menggunakan persona owner_';
        await reply(`🎭 *Persona Grup: ${group.name}*\n\n${current}`);
        return;
      }

      // Clear persona dari DM
      if (personaText.toLowerCase() === 'clear') {
        try {
          await setGroupPersona(groupJid, null);
          await resetSession(sender);
          await reply(
            `🗑️ Persona grup *${group.name}* dihapus.\n` +
            `_Bot akan menggunakan persona owner saat chat di grup ini._`
          );
        } catch (err) {
          logger.error({ err: err.message }, 'Error di group persona clear (DM)');
          await reply('⚠️ Terjadi kesalahan saat menghapus persona grup.');
        }
        return;
      }

      // Set persona dari DM
      try {
        await setGroupPersona(groupJid, personaText);
        await resetSession(sender);
        await reply(
          `✅ Persona grup *${group.name}* berhasil diset!\n\n` +
          `_Session AI direset agar persona baru langsung aktif._`
        );
      } catch (err) {
        logger.error({ err: err.message }, 'Error di group persona set (DM)');
        await reply('⚠️ Terjadi kesalahan saat mengatur persona grup.');
      }
      return;
    }

    // ── Sub-command tidak dikenal ─────────────────────────────────────────
    await reply(
      `❓ Sub-command *${sub}* tidak dikenal.\nKetik *!group* untuk melihat daftar command.`
    );
  },
};