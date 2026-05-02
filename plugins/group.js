// plugins/group.js
// Plugin manajemen grup WhatsApp untuk owner.
//
// Commands:
//   !group create <nama>                   → Buat grup baru, owner otomatis dimasukkan
//   !group delete <groupJid>               → Bot keluar dan hapus grup dari daftar
//   !group list                            → Tampilkan semua grup terdaftar
//   !group register [nama]                 → Daftarkan grup ini (jika diketik di dalam grup)
//                                            atau: !group register <groupJid> <nama> (dari DM)
//   !group channel <groupJid> <pluginKey> <input|output|both|none>
//                                          → Set grup sebagai channel plugin
//   !group info [groupJid]                 → Detail grup dan channel yang aktif

import {
  createGroup,
  deleteGroup,
  listGroups,
  registerGroup,
  setGroupChannel,
  findGroup,
} from '../services/groupService.js';
import logger from '../utils/logger.js';

export default {
  name: 'group',
  description: 'Manajemen grup WhatsApp (buat, hapus, channel input/output)',
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
        `  → Detail grup dan channel aktif\n\n` +
        `*!group channel* <groupJid> <pluginKey> <input|output|both|none>\n` +
        `  → Set grup sebagai channel input/output plugin\n\n` +
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
          `_Gunakan !group channel untuk mengatur channel plugin._`
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
        // Mode otomatis: ambil JID dari konteks pesan dan nama dari metadata grup
        const groupJid = jid;
        let groupName = args.slice(1).join(' ').trim(); // nama opsional dari args

        // Jika nama tidak diberikan, ambil dari metadata grup via Baileys
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
            `_Gunakan !group channel untuk mengatur channel plugin._`
          );
        } catch (err) {
          logger.error({ err: err.message }, 'Error di group register (auto)');
          await reply('⚠️ Terjadi kesalahan saat mendaftarkan grup.');
        }
        return;
      }

      // Mode manual dari DM: !group register <groupJid> <nama>
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
          return `${i + 1}. *${g.name}*\n   JID: \`${g.groupJid}\`\n   Channel: _${channelInfo}_`;
        });

        await reply(`📋 *Daftar Grup (${groups.length})*\n\n${lines.join('\n\n')}`);
      } catch (err) {
        logger.error({ err: err.message }, 'Error di group list');
        await reply('⚠️ Terjadi kesalahan saat mengambil daftar grup.');
      }
      return;
    }

    // ── !group info [groupJid] ────────────────────────────────────────────
    // Jika diketik di dalam grup dan tidak ada args → auto pakai JID grup ini
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

      await reply(
        `📌 *Info Grup*\n\n` +
        `Nama: *${group.name}*\n` +
        `JID: \`${group.groupJid}\`\n` +
        `Dibuat: ${group.createdAt}\n\n` +
        `*Channel:*\n${channelLines}\n\n` +
        `_Gunakan !group channel untuk mengatur channel plugin._`
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

    // ── Sub-command tidak dikenal ─────────────────────────────────────────
    await reply(
      `❓ Sub-command *${sub}* tidak dikenal.\nKetik *!group* untuk melihat daftar command.`
    );
  },
};