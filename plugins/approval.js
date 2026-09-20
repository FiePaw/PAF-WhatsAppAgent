// plugins/approval.js
// [Fitur 2 · Approval Owner untuk Membalas Nomor Lain]
// Command manual owner untuk override alur approval otomatis:
//   !approve <nomor> [jam]  → whitelist manual (override blocklist), default 24 jam
//   !block <nomor>          → blokir manual tanpa menunggu alur approval
//   !unblock <nomor>        → hapus status approval (kembali "belum ada status")
//   !approvals              → lihat daftar permintaan approval yang pending

import approvalStore from '../services/approvalStore.js';

function toJid(number) {
  const clean = number.replace(/\D/g, '');
  return `${clean}@s.whatsapp.net`;
}

const plugin = {
  name: 'Approval Manager',
  description: 'Kelola whitelist/blocklist approval nomor non-owner',
  commands: ['approve', 'block', 'unblock', 'approvals'],
  ownerOnly: true,

  handler: async ({ command, args, reply }) => {
    if (command === 'approve') {
      const number = args[0];
      const hours = args[1] ? parseFloat(args[1]) : undefined;

      if (!number) {
        await reply('❓ Gunakan: *!approve <nomor> [jam]*\n\nContoh: `!approve 628111222333` (default 24 jam) atau `!approve 628111222333 3` (3 jam)');
        return;
      }

      await approvalStore.approve(toJid(number), hours);
      await reply(`✅ Nomor \`${number}\` di-approve selama ${hours || 24} jam (manual override).`);
      return;
    }

    if (command === 'block') {
      const number = args[0];
      if (!number) {
        await reply('❓ Gunakan: *!block <nomor>*');
        return;
      }

      await approvalStore.deny(toJid(number));
      await reply(`🚫 Nomor \`${number}\` diblokir permanen (manual).`);
      return;
    }

    if (command === 'unblock') {
      const number = args[0];
      if (!number) {
        await reply('❓ Gunakan: *!unblock <nomor>*');
        return;
      }

      await approvalStore.unblock(toJid(number));
      await reply(`🗑️ Status approval untuk \`${number}\` dihapus.\n_Nomor ini akan melalui alur approval lagi jika chat._`);
      return;
    }

    if (command === 'approvals') {
      const pending = approvalStore.listPending();
      if (!pending.length) {
        await reply('📭 Tidak ada permintaan approval yang pending.');
        return;
      }

      const lines = pending.map((p, i) => {
        const preview = (p.originalText || '(tanpa teks)').slice(0, 50);
        return `${i + 1}. \`${p.senderJid.split('@')[0]}\` — "${preview}"`;
      });

      await reply(`📋 *Pending Approval (${pending.length}):*\n${lines.join('\n')}\n\n_Reply notifikasi approval terkait untuk memutuskan._`);
      return;
    }
  },
};

export default plugin;
