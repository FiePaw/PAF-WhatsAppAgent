// plugins/triggered/sendMessage.js
// Triggered plugin: kirim pesan WhatsApp ke nomor lain atas perintah owner.
//
// Contoh perintah owner:
//   "kirim pesan ke 628111111111 bilang saya terlambat"
//   "tolong hubungi 628222222222 dan kasih tau meeting jam 3"

export default {
  // ─── Intent identifier ───────────────────────────────────────────────────
  // Harus unik di antara semua triggered plugin.
  // Qwen akan return { intent: 'sendMessage', params: { ... } } jika cocok.
  intent: 'sendMessage',

  // ─── Intent definition untuk system prompt Qwen ──────────────────────────
  // String ini akan di-inject ke system prompt intent session secara otomatis.
  // Tulis sejelas mungkin: nama intent, kapan valid, dan params apa yang diekstrak.
  intentDefinition: `"sendMessage" - owner ingin mengirim pesan ke nomor WhatsApp lain. Ekstrak: targetNumber (string, angka saja tanpa + atau spasi, format internasional 628xxx) dan message (string, isi pesan yang ingin disampaikan, tulis ulang secara natural orang pertama sesuai maksud owner). Intent ini valid hanya jika nomor target eksplisit disebutkan.`,

  // ─── Context prompt untuk grup ───────────────────────────────────────────
  // Otomatis jadi persona grup saat plugin ini di-assign sebagai channel input/both.
  // Tulis konteks domain yang relevan agar chat session AI di grup ini
  // punya pemahaman yang sama dengan intent session.
  groupContextPrompt: `Kamu adalah asisten pengiriman pesan pribadi owner. Kamu memahami bahwa owner sering meminta untuk mengirimkan pesan ke kontak tertentu melalui WhatsApp. Bantu owner merumuskan pesan yang natural dan sesuai konteks. Jawab ringkas seperti chat biasa dalam Bahasa Indonesia.`,

  // ─── Plugin metadata ─────────────────────────────────────────────────────
  name: 'Send Message',
  description: 'Kirim pesan WhatsApp ke nomor tertentu atas perintah owner',
  ownerOnly: true,

  // ─── Handler ─────────────────────────────────────────────────────────────
  /**
   * @param {object} ctx
   * @param {object} ctx.sock       - Baileys socket
   * @param {object} ctx.msg        - Baileys message object
   * @param {string} ctx.jid        - JID chat saat ini
   * @param {string} ctx.sender     - JID sender (owner)
   * @param {boolean} ctx.isOwner   - selalu true untuk triggered plugin ownerOnly
   * @param {string} ctx.text       - teks asli pesan owner
   * @param {Function} ctx.reply    - helper reply ke chat saat ini
   * @param {object} ctx.params     - hasil ekstraksi Qwen: { targetNumber, message }
   */
  handler: async ({ sock, reply, params }) => {
    const { targetNumber, message } = params;

    // Validasi params dari Qwen
    if (!targetNumber || !message) {
      await reply('⚠️ Tidak bisa mengirim pesan: nomor tujuan atau isi pesan tidak lengkap.');
      return;
    }

    // Normalisasi: pastikan format JID benar
    const targetJid = `${targetNumber.replace(/\D/g, '')}@s.whatsapp.net`;

    try {
      await sock.sendMessage(targetJid, { text: message });
      await reply(`✅ Pesan berhasil dikirim ke *${targetNumber}*:\n_${message}_`);
    } catch (err) {
      await reply(`❌ Gagal kirim pesan ke ${targetNumber}: ${err.message}`);
    }
  },
};