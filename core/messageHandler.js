// core/messageHandler.js
import { downloadMediaMessage } from '@whiskeysockets/baileys';
import config from '../config/config.js';
import { isOwner, isCommand, parseCommand } from '../utils/helpers.js';
import { typingDelay, replySegmented } from '../utils/delay.js';
import { askAI, askAISegmented, askAITool, describeImage, describeDocument, describeSocialMedia } from '../services/aiService.js';
import { getPersona } from '../services/personaService.js';
import { handleTriggeredPlugin } from './triggeredPluginHandler.js';
import { getGroupChannel, getGroupPersona } from '../services/groupService.js';
import { recordMessage, getHistory } from '../services/chatHistoryService.js';
import { extractSocialMediaUrl, downloadSocialMedia } from '../services/socialMediaService.js';
import approvalStore from '../services/approvalStore.js';
import { buildFunctionTool } from '../utils/toolCalling.js';
import logger from '../utils/logger.js';

/**
 * [Fix Bug 2 & 3 · Double-Reply Race Condition] Timeout wajar untuk deteksi
 * intent (round-trip ke Qwen) sebelum fallback ke chat AI biasa. Lihat
 * withTimeout() di bawah — dipakai agar deteksi intent yang macet/lambat
 * tidak membuat bot diam total menunggu selamanya.
 */
const INTENT_DETECTION_TIMEOUT_MS = 20_000;

/**
 * Race sebuah promise melawan timeout — jika promise belum selesai dalam
 * `ms` milidetik, resolve dengan `timeoutValue` alih-alih menunggu terus.
 * CATATAN: promise asli TIDAK dibatalkan (JS tidak punya cancellation
 * native) — ia tetap berjalan di background dan bisa selesai belakangan.
 * Ini sebabnya messageHandler.js memasang `replyGuard` di sekitar
 * pemanggilan withTimeout(handleTriggeredPlugin(...)) — supaya jika plugin
 * baru selesai SETELAH timeout (dan AI chat sudah lanjut/reply), reply dari
 * plugin yang terlambat itu tidak ikut terkirim dobel ke user.
 *
 * @param {Promise} promise
 * @param {number} ms
 * @param {*} timeoutValue
 * @returns {Promise<*>}
 */
function withTimeout(promise, ms, timeoutValue) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(timeoutValue), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Fix #2 — Segmented Typing Reply lebih paham kapan harus pecah pesan.
 * Hitung sinyal konteks NUMERIK dari chatHistory sebelum memanggil
 * askAISegmented, supaya AI punya bukti nyata (bukan hanya menerka dari
 * nada teks) saat memutuskan jumlah segmen. Lihat buildContextHintsBlock()
 * di services/aiService.js untuk bagaimana ini dirender ke prompt.
 *
 * @param {string} jid       - jid yang dipakai untuk lookup chatHistory
 * @param {string} userText  - teks pesan user saat ini
 * @returns {{ userMessageLength: number, secondsSinceLastMessage: number|undefined, messagesLastFiveMin: number }}
 */
function computeContextHints(jid, userText) {
  const history = getHistory(jid) || [];
  const now = Date.now();

  const lastEntry = history[history.length - 1];
  const secondsSinceLastMessage = lastEntry
    ? Math.max(0, Math.floor((now - new Date(lastEntry.timestamp).getTime()) / 1000))
    : undefined;

  const fiveMinAgo = now - 5 * 60 * 1000;
  const messagesLastFiveMin = history.filter((m) => new Date(m.timestamp).getTime() >= fiveMinAgo).length;

  return {
    userMessageLength: userText?.length ?? 0,
    secondsSinceLastMessage,
    messagesLastFiveMin,
  };
}

/**
 * Jika pesan mengandung gambar, minta Qwen mendeskripsikan gambar tersebut
 * lalu simpan hasilnya ke chatHistory sebagai pesan user dengan prefix [Gambar].
 * Berjalan fire-and-forget — tidak memblokir proses chat utama.
 *
 * @param {object} options
 * @param {string} options.jid
 * @param {string} options.sender
 * @param {Array}  options.attachments - hasil extractImageAttachment
 * @param {string} [options.caption]   - caption gambar jika ada
 */
async function recordImageToHistory({ jid, sender, attachments, caption }) {
  if (!attachments?.length) return;

  try {
    const description = await describeImage({ jid, attachments, caption });
    if (!description) return;

    // Simpan ke history dengan format jelas: [Gambar] + deskripsi Qwen
    const captionPart = caption?.trim() ? ` (caption: "${caption.trim()}")` : '';
    const historyText = `[Gambar${captionPart}] ${description}`;

    await recordMessage({ jid, role: 'user', text: historyText, sender });
    logger.debug({ jid }, '🖼️ chatHistory: deskripsi gambar tersimpan');
  } catch (err) {
    logger.warn({ jid, err: err.message }, '⚠️ Gagal record gambar ke chatHistory');
  }
}

/**
 * [Fitur 1 · Baca & Pahami Isi File] Jika pesan mengandung dokumen (PDF,
 * DOCX, PPTX, dll), minta Qwen meringkas isi dokumen tersebut lalu simpan
 * hasilnya ke chatHistory dengan prefix [Dokumen: <nama file>]. Konsisten
 * dengan pola recordImageToHistory di atas — fire-and-forget.
 *
 * @param {object} options
 * @param {string} options.jid
 * @param {string} options.sender
 * @param {Array}  options.attachments - hasil extractDocumentAttachment
 * @param {string} [options.caption]   - caption/keterangan dokumen jika ada
 */
async function recordDocumentToHistory({ jid, sender, attachments, caption }) {
  if (!attachments?.length) return;

  try {
    const description = await describeDocument({ jid, attachments, caption });
    if (!description) return;

    const filename = attachments[0]?.filename || 'dokumen';
    const captionPart = caption?.trim() ? ` (caption: "${caption.trim()}")` : '';
    const historyText = `[Dokumen: ${filename}${captionPart}] ${description}`;

    await recordMessage({ jid, role: 'user', text: historyText, sender });
    logger.debug({ jid }, '📄 chatHistory: ringkasan dokumen tersimpan');
  } catch (err) {
    logger.warn({ jid, err: err.message }, '⚠️ Gagal record dokumen ke chatHistory');
  }
}

/**
 * [Fitur 3 · Konteks dari URL Instagram/TikTok] Jika pesan mengandung URL
 * medsos yang berhasil didownload, minta Qwen meringkas isi video tersebut
 * lalu simpan ke chatHistory dengan prefix [Video dari <url>]. Fire-and-forget.
 *
 * @param {object} options
 * @param {string} options.jid
 * @param {string} options.sender
 * @param {object} options.attachment - hasil downloadSocialMedia().attachment
 * @param {object} [options.metadata] - hasil downloadSocialMedia().metadata
 * @param {string} options.url
 */
async function recordSocialMediaToHistory({ jid, sender, attachment, metadata, url }) {
  if (!attachment) return;

  try {
    const caption = metadata?.title || metadata?.description || '';
    const description = await describeSocialMedia({ jid, attachments: [attachment], caption });
    if (!description) return;

    const historyText = `[Video dari ${url}] ${description}`;
    await recordMessage({ jid, role: 'user', text: historyText, sender });
    logger.debug({ jid }, '🎬 chatHistory: ringkasan video media sosial tersimpan');
  } catch (err) {
    logger.warn({ jid, err: err.message }, '⚠️ Gagal record video media sosial ke chatHistory');
  }
}

/**
 * Ekstrak gambar dari pesan WhatsApp dan convert ke format attachment untuk aiService.
 * Return null jika pesan bukan gambar atau gagal download.
 *
 * @param {object} sock
 * @param {object} msg
 * @returns {Promise<Array|null>} attachments array atau null
 */
async function extractImageAttachment(sock, msg) {
  const imageMsg = msg.message?.imageMessage;
  if (!imageMsg) return null;

  try {
    const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage });
    const base64 = buffer.toString('base64');
    const mimeType = imageMsg.mimetype || 'image/jpeg';
    const filename = `image_${Date.now()}.${mimeType.split('/')[1] || 'jpg'}`;

    logger.debug({ filename, mimeType, size: buffer.length }, '🖼️ Gambar berhasil di-download');

    return [{ filename, data: base64, mime_type: mimeType }];
  } catch (err) {
    logger.error({ err: err.message }, '❌ Gagal download gambar dari pesan');
    return null;
  }
}

/**
 * [Fitur 1 · Baca & Pahami Isi File] Ambil object documentMessage dari pesan
 * Baileys, menangani dua bentuk pembungkus: dokumen polos (documentMessage)
 * dan dokumen dengan caption (documentWithCaptionMessage.message.documentMessage).
 *
 * @param {object} msg
 * @returns {object|null}
 */
function detectDocumentMessage(msg) {
  return (
    msg.message?.documentMessage ||
    msg.message?.documentWithCaptionMessage?.message?.documentMessage ||
    null
  );
}

/**
 * [Fitur 1 · Baca & Pahami Isi File] Ekstrak dokumen (PDF, DOCX, PPTX, dll)
 * dari pesan WhatsApp dan convert ke format attachment yang sama dengan
 * gambar — mirip extractImageAttachment(). Opsi B (lihat rencana fitur):
 * file dikirim UTUH sebagai base64, tanpa ekstraksi teks lokal.
 *
 * @param {object} sock
 * @param {object} msg
 * @returns {Promise<Array|null>} attachments array atau null
 */
async function extractDocumentAttachment(sock, msg) {
  const docMsg = detectDocumentMessage(msg);
  if (!docMsg) return null;

  try {
    const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage });
    const base64 = buffer.toString('base64');
    const mimeType = docMsg.mimetype || 'application/octet-stream';
    const filename = docMsg.fileName || `document_${Date.now()}`;

    logger.debug({ filename, mimeType, size: buffer.length }, '📄 Dokumen berhasil di-download');

    return [{ filename, data: base64, mime_type: mimeType }];
  } catch (err) {
    logger.error({ err: err.message }, '❌ Gagal download dokumen dari pesan');
    return null;
  }
}

/**
 * [Fitur 2 · Approval Owner] Pakai askAITool untuk menginterpretasikan
 * balasan natural owner terhadap notifikasi approval nomor baru — bukan
 * keyword kaku. Mengembalikan { decision: 'approve'|'deny', durationHours }.
 *
 * @param {string} ownerText
 * @returns {Promise<{ decision: 'approve'|'deny', durationHours: number|null }>}
 */
async function resolveApprovalDecision(ownerText) {
  const tool = buildFunctionTool(
    'report_approval_decision',
    'Laporkan keputusan owner terhadap permintaan approval nomor WhatsApp baru: setuju (approve) atau tolak (deny), beserta durasi approval dalam jam jika owner menyebutkan durasi custom.',
    {
      type: 'object',
      properties: {
        decision: { type: 'string', enum: ['approve', 'deny'], description: 'Keputusan owner terhadap permintaan approval ini' },
        durationHours: { type: 'number', description: 'Durasi approval dalam jam jika owner menyebutkan durasi custom (mis. "boleh 3 jam" -> 3). Kosongkan jika owner tidak menyebutkan durasi (pakai default 24 jam).' },
      },
      required: ['decision'],
    }
  );

  try {
    const result = await askAITool({
      jid: `approval_decision_${Date.now()}`,
      userText: `Owner membalas notifikasi permintaan approval nomor WhatsApp baru dengan pesan berikut:\n"${ownerText}"\n\nTentukan apakah ini approve atau deny, dan durasi approval (jam) jika disebutkan secara eksplisit.`,
      systemPrompt: 'Kamu adalah sistem interpretasi keputusan approval. Gunakan fungsi yang tersedia untuk melaporkan hasil.',
      tools: [tool],
      forceNew: true,
      useMemory: false,
    });

    if (result.name !== 'report_approval_decision') {
      return { decision: 'deny', durationHours: null };
    }
    return {
      decision: result.args.decision === 'approve' ? 'approve' : 'deny',
      durationHours: result.args.durationHours || null,
    };
  } catch (err) {
    logger.error({ err: err.message }, '❌ Gagal interpretasi keputusan approval, default deny');
    return { decision: 'deny', durationHours: null };
  }
}

/**
 * [Fitur 2 · Approval Owner] Kirim balasan AI standar (persona non-owner)
 * untuk satu pesan — dipakai baik untuk alur normal non-owner maupun untuk
 * memproses pesan-pesan yang sempat menumpuk (pending) setelah owner approve.
 *
 * @param {object} options
 * @param {object} options.sock
 * @param {string} options.jid
 * @param {string} options.sender
 * @param {object|null} [options.msg]  - Baileys message object untuk quoting, null jika tidak ada (reprocessed message)
 * @param {string} options.text
 * @param {Array}  [options.attachments]
 */
async function sendAIReply({ sock, jid, sender, msg = null, text, attachments }) {
  const { prompt: systemPrompt } = getPersona(sender, false);

  try {
    const contextHints = computeContextHints(sender, text);
    const segments = await askAISegmented({ jid: sender, userText: text, systemPrompt, attachments, contextHints });
    const fullText = segments.map((s) => s.text).join(' ');
    await replySegmented(sock, jid, segments, msg);
    recordMessage({ jid, role: 'bot', text: fullText, sender: 'bot' }).catch(() => {});
  } catch (err) {
    logger.error({ sender, err: err.message }, 'Error saat request ke AI');
    try {
      const fallback = '❌ Maaf, terjadi kesalahan. Coba lagi nanti.';
      await typingDelay(sock, jid, fallback);
      await sock.sendMessage(jid, { text: fallback }, msg ? { quoted: msg } : {});
    } catch {
      // ignore
    }
  }
}

/**
 * [Fitur 2 · Approval Owner] Mulai alur approval untuk sender non-owner yang
 * belum punya status (belum whitelist/blocklist). Generate pemahaman singkat
 * dari pesan, kirim notifikasi ke owner, simpan pending request keyed by
 * messageId notifikasi tersebut.
 *
 * @param {object} options
 * @param {object} options.sock
 * @param {string} options.jid      - JID chat asal (tempat sender mengirim pesan)
 * @param {string} options.sender
 * @param {string} options.text
 * @param {Array}  [options.attachments]
 */
async function handleApprovalRequest({ sock, jid, sender, text, attachments }) {
  const ownerJid = config.ownerLid || config.ownerJid;
  if (!ownerJid) {
    logger.warn('Owner JID belum diset, tidak bisa proses approval — pesan diabaikan');
    return;
  }

  // Generate pemahaman singkat pesan (single-shot, tanpa session/memory)
  let understanding = text?.trim() ? text.slice(0, 200) : '(pesan tanpa teks / hanya lampiran)';
  try {
    const summary = await askAI({
      jid: `approval_summary_${sender}_${Date.now()}`,
      userText: `Ringkas pesan WhatsApp berikut dalam SATU kalimat singkat (maksimal 20 kata), Bahasa Indonesia, fokus pada maksud pengirim:\n\n"${text}"`,
      forceNew: true,
      useMemory: false,
    });
    if (summary?.trim()) understanding = summary.trim();
  } catch {
    // fallback pakai potongan text asli jika gagal
  }

  const senderNumber = sender.split('@')[0];
  const notifText =
    `🔔 *Permintaan Approval — Nomor Baru*\n\n` +
    `📱 Nomor: \`${senderNumber}\`\n` +
    `💬 Pemahaman pesan: ${understanding}\n\n` +
    `Reply pesan ini untuk memutuskan:\n` +
    `• "boleh" / "approve" / "oke" → izinkan (default 24 jam)\n` +
    `• "boleh 3 jam" → izinkan dengan durasi custom\n` +
    `• "tolak" / "jangan" / "block" → tolak permanen\n\n` +
    `_Tanpa respons dalam 24 jam, otomatis ditolak (masuk blocklist)._`;

  try {
    const sent = await sock.sendMessage(ownerJid, { text: notifText });
    const messageId = sent?.key?.id;
    if (messageId) {
      approvalStore.addPending(messageId, {
        senderJid: sender,
        chatJid: jid,
        originalText: text,
        attachments: attachments?.length ? attachments : null,
      });
      logger.info({ sender: senderNumber, messageId }, '🔔 approvalStore: notifikasi approval terkirim ke owner');
    } else {
      logger.warn({ sender: senderNumber }, '⚠️ Tidak dapat ambil messageId notifikasi approval, request tidak tersimpan');
    }
  } catch (err) {
    logger.error({ sender: senderNumber, err: err.message }, '❌ Gagal kirim notifikasi approval ke owner');
  }
}

/**
 * [Fitur 2 · Approval Owner] Owner reply ke notifikasi approval — interpretasi
 * keputusan lalu eksekusi: approve (whitelist + proses semua pesan pending
 * dari sender itu) atau deny (blocklist permanen + buang semua pending).
 *
 * @param {object} options
 * @param {object} options.sock
 * @param {string} options.jid       - jid chat saat ini (DM owner)
 * @param {object} options.pending   - pending request yang di-reply (dari approvalStore.getPending)
 * @param {string} options.ownerText - teks balasan owner
 * @param {Function} options.reply
 */
async function handleApprovalReply({ sock, jid, pending, ownerText, reply }) {
  const { decision, durationHours } = await resolveApprovalDecision(ownerText);
  const senderNumber = pending.senderJid.split('@')[0];

  // Ambil SEMUA pending request dari sender yang sama (bisa lebih dari satu
  // jika sender kirim beberapa pesan beruntun sebelum owner sempat merespons)
  const allPending = approvalStore.getPendingForSender(pending.senderJid);
  for (const p of allPending) {
    approvalStore.removePending(p.messageId);
  }

  if (decision === 'approve') {
    await approvalStore.approve(pending.senderJid, durationHours || undefined);
    await reply(
      `✅ Nomor \`${senderNumber}\` di-approve selama ${durationHours || 24} jam.` +
      (allPending.length ? ` Memproses ${allPending.length} pesan yang tertunda...` : '')
    );

    for (const p of allPending) {
      if (p.originalText?.trim()) {
        recordMessage({ jid: p.chatJid, role: 'user', text: p.originalText, sender: p.senderJid }).catch(() => {});
      }
      sendAIReply({ sock, jid: p.chatJid, sender: p.senderJid, msg: null, text: p.originalText, attachments: p.attachments }).catch((err) => {
        logger.error({ sender: senderNumber, err: err.message }, '❌ Gagal proses pesan pending setelah approve');
      });
    }
  } else {
    await approvalStore.deny(pending.senderJid);
    await reply(`🚫 Nomor \`${senderNumber}\` ditolak dan dimasukkan ke blocklist permanen.`);
  }
}

/**
 * Handle setiap pesan masuk
 * @param {object} sock - Baileys socket
 * @param {object} msg  - Baileys message object
 * @param {Map}    plugins - Map<command, plugin>
 */
export async function handleMessage(sock, msg, plugins) {
  // Abaikan pesan dari diri sendiri
  if (msg.key.fromMe) return;

  const jid = msg.key.remoteJid;

  // Abaikan status broadcast
  if (jid === 'status@broadcast') return;

  // ── Deteksi tipe pesan ──────────────────────────────────────────────
  const hasImage = !!msg.message?.imageMessage;
  const documentMsg = detectDocumentMessage(msg);
  const hasDocument = !!documentMsg;

  // Ambil teks pesan (caption jika gambar/dokumen)
  const text =
    msg.message?.conversation ||
    msg.message?.extendedTextMessage?.text ||
    msg.message?.imageMessage?.caption ||
    msg.message?.videoMessage?.caption ||
    msg.message?.documentMessage?.caption ||
    msg.message?.documentWithCaptionMessage?.message?.documentMessage?.caption ||
    '';

  // Pesan tanpa teks dan tanpa lampiran apapun → abaikan
  if (!text.trim() && !hasImage && !hasDocument) return;

  const sender = msg.key.participant || jid;
  const owner = isOwner(sender);
  const isGroup = jid.endsWith('@g.us');

  // ── Ekstrak quoted message (reply bubble) ────────────────────────────
  // Ambil teks dari pesan yang di-reply user, dari semua kemungkinan tipe pesan
  const contextInfo =
    msg.message?.extendedTextMessage?.contextInfo ||
    msg.message?.imageMessage?.contextInfo ||
    msg.message?.videoMessage?.contextInfo ||
    msg.message?.documentMessage?.contextInfo ||
    msg.message?.documentWithCaptionMessage?.message?.documentMessage?.contextInfo ||
    null;

  const quotedText =
    contextInfo?.quotedMessage?.conversation ||
    contextInfo?.quotedMessage?.extendedTextMessage?.text ||
    contextInfo?.quotedMessage?.imageMessage?.caption ||
    contextInfo?.quotedMessage?.videoMessage?.caption ||
    null;

  // ── reply() helper (dipakai duluan oleh cek approval-reply di bawah) ──
  const reply = async (replyText) => {
    await typingDelay(sock, jid, replyText);
    await sock.sendMessage(jid, { text: replyText }, { quoted: msg });
  };

  // ── [Fitur 2] Deteksi owner sedang reply ke notifikasi approval ──────
  // Dicek sedini mungkin (sebelum command/group/AI flow apapun) karena
  // balasan owner biasanya teks natural tanpa prefix command.
  if (owner && contextInfo?.stanzaId) {
    const pending = approvalStore.getPending(contextInfo.stanzaId);
    if (pending) {
      try {
        await handleApprovalReply({ sock, jid, pending, ownerText: text, reply });
      } catch (err) {
        logger.error({ err: err.message }, '❌ Gagal proses keputusan approval owner');
        await reply('⚠️ Gagal memproses keputusan approval. Coba lagi.');
      }
      return;
    }
  }

  // ── Ekstrak lampiran (gambar/dokumen) jika ada ───────────────────────
  const imageAttachments = hasImage ? await extractImageAttachment(sock, msg) : null;
  const documentAttachments = hasDocument ? await extractDocumentAttachment(sock, msg) : null;

  // ── [Fitur 3] Deteksi & download URL Instagram/TikTok di teks ───────
  // Hanya untuk pesan natural (bukan command) — konsisten dengan gambar/
  // dokumen yang juga cuma diproses di jalur chat natural.
  const socialUrl = !isCommand(text) ? extractSocialMediaUrl(text) : null;
  const socialResult = socialUrl ? await downloadSocialMedia(socialUrl) : null;
  const socialAttachments = socialResult ? [socialResult.attachment] : null;

  // Gabungkan semua lampiran menjadi satu array generik untuk dikirim ke AI
  // (routing model ke Qwen sudah otomatis generik berdasar attachments.length)
  const attachments = [
    ...(imageAttachments || []),
    ...(documentAttachments || []),
    ...(socialAttachments || []),
  ];

  // ── Bangun intentText dengan konteks quote + lampiran jika ada ───────
  // Format: "[Reply: "<teks yang dikutip>"]\n<pesan user>"
  const attachmentMarkers = [];
  if (hasImage) attachmentMarkers.push('[gambar dikirim]');
  if (hasDocument) attachmentMarkers.push(`[dokumen dikirim: ${documentMsg?.fileName || 'file'}]`);

  let rawIntentText = text.trim() || (attachmentMarkers.length ? attachmentMarkers.join(' ') : '');

  if (socialResult) {
    const meta = socialResult.metadata || {};
    const metaParts = [];
    if (meta.title) metaParts.push(`judul: "${meta.title}"`);
    if (meta.description) metaParts.push(`deskripsi: "${meta.description.slice(0, 200)}"`);
    rawIntentText += metaParts.length
      ? `\n[Video dari ${socialUrl} — ${metaParts.join(', ')}]`
      : `\n[Video dari ${socialUrl}]`;
  } else if (socialUrl && !socialResult) {
    // Download gagal — tetap catat URL-nya sebagai konteks teks biasa,
    // biarkan AI tahu ada URL yang gagal diproses alih-alih diam saja.
    rawIntentText += `\n[Catatan: gagal mengambil konten dari ${socialUrl}]`;
  }

  const intentText = quotedText?.trim()
    ? `[Reply: "${quotedText.trim()}"]\n${rawIntentText}`
    : rawIntentText;

  logger.info(
    { jid, sender: sender.split('@')[0], owner, isGroup, hasImage, hasDocument, hasSocialUrl: !!socialUrl, hasQuote: !!quotedText, text: text.slice(0, 60) },
    '📩 Pesan masuk'
  );

  // ─── Group Routing ───────────────────────────────────────────────────
  // Semua grup terdaftar: owner bisa chat AI, command, dan intent detection.
  // Grup tidak terdaftar: semua pesan diabaikan.
  if (isGroup) {
    const channel = getGroupChannel(jid);

    // Grup tidak terdaftar → hanya izinkan !group register dari owner
    if (!channel) {
      if (!owner) return;
      if (isCommand(text)) {
        const { command, args, fullArgs } = parseCommand(text);
        if ((command === 'group' || command === 'grp') && args[0]?.toLowerCase() === 'register') {
          const plugin = plugins.get(command);
          if (plugin) {
            try {
              await plugin.handler({
                sock, msg, jid, sender,
                isOwner: owner, text, command, args, fullArgs, reply,
              });
            } catch (err) {
              logger.error({ command, jid, err: err.message }, 'Error di group register (unregistered group)');
              await reply('⚠️ Terjadi kesalahan saat mendaftarkan grup.');
            }
          }
        }
      }
      return;
    }

    // Hanya owner yang bisa berinteraksi di grup terdaftar
    if (!owner) return;

    // ── Command handler di grup ────────────────────────────────────────
    if (isCommand(text)) {
      const { command, args, fullArgs } = parseCommand(text);
      const plugin = plugins.get(command);

      // Command tidak dikenal → diam saja di grup (tidak reply error)
      if (!plugin) return;

      try {
        await plugin.handler({
          sock, msg, jid, sender,
          isOwner: owner, text, command, args, fullArgs, reply,
          groupChannel: channel,
        });
      } catch (err) {
        logger.error({ command, jid, err: err.message }, 'Error di plugin handler (group)');
        await reply('⚠️ Terjadi kesalahan saat menjalankan command.');
      }
      return;
    }

    // ── Pesan natural owner di grup → intent detection lalu AI chat ─────
    // [Fix Bug 2 & 3 · Double-Reply Race Condition] Sebelumnya dijalankan
    // PARALEL (intent + AI chat sekaligus) dengan guard Promise.race yang
    // tidak reliable — plugin bisa mengirim reply sendiri (via
    // interceptedReply di core/triggeredPluginHandler.js) independen dari
    // apakah AI chat sudah/belum reply, menyebabkan user bisa menerima 2
    // balasan untuk 1 pesan. Fix: SEQUENTIAL — intent detection dulu (dengan
    // timeout), baru fallback ke AI chat kalau tidak ada intent yang cocok.
    // replyGuard menutup celah residual: jika plugin baru selesai SETELAH
    // timeout (saat AI chat sudah mulai/reply), reply-nya diabaikan.
    const groupPersona = getGroupPersona(jid);
    const ownerPersonaObj = getPersona(sender, owner);
    const groupSystemPrompt = groupPersona || ownerPersonaObj.prompt;
    // Model dipilih otomatis oleh askAISegmented (deepseek untuk chat, qwen jika ada lampiran)

    const groupReplyGuard = { sent: false };
    const groupGuardedReply = async (replyText) => {
      if (groupReplyGuard.sent) {
        logger.warn({ jid }, '⚠️ Intent plugin grup selesai setelah timeout & AI sudah reply — diabaikan (race-safety)');
        return;
      }
      await reply(replyText);
    };

    const groupCtx = { sock, msg, jid, sender, isOwner: owner, text: intentText, reply: groupGuardedReply, groupChannel: channel, attachments };

    const groupIntentHandled = channel.input
      ? await withTimeout(
          handleTriggeredPlugin(groupCtx).catch((err) => {
            logger.error({ sender, jid, err: err.message }, 'Error di intent detection grup');
            return false;
          }),
          INTENT_DETECTION_TIMEOUT_MS,
          false
        )
      : false;

    if (groupIntentHandled) {
      // Plugin sudah mengirim reply-nya sendiri — selesai, JANGAN panggil AI chat.
      return;
    }

    // Tutup guard SEBELUM mulai AI chat — plugin yang selesai belakangan
    // (setelah timeout) tidak akan bisa ikut reply lagi.
    groupReplyGuard.sent = true;

    const groupContextHints = computeContextHints(jid, intentText);
    try {
      const groupSegments = await askAISegmented({ jid: jid, userText: intentText, systemPrompt: groupSystemPrompt, attachments, contextHints: groupContextHints });
      await replySegmented(sock, jid, groupSegments, msg);
    } catch (err) {
      logger.error({ sender, jid, err: err.message }, 'Error saat request ke AI (group)');
      await reply('❌ Maaf, terjadi kesalahan. Coba lagi nanti.');
    }
    return;
  }

  // ─── Command Handler (DM) ────────────────────────────────────────────
  if (isCommand(text)) {
    const { command, args, fullArgs } = parseCommand(text);
    const plugin = plugins.get(command);

    if (!plugin) {
      await reply(`❓ Command *${config.botPrefix}${command}* tidak dikenal.\nKetik *${config.botPrefix}help* untuk daftar command.`);
      return;
    }

    if (plugin.ownerOnly && !owner) {
      await reply('🔒 Command ini hanya untuk owner.');
      return;
    }

    try {
      await plugin.handler({ sock, msg, jid, sender, isOwner: owner, text, command, args, fullArgs, reply });
    } catch (err) {
      logger.error({ command, err: err.message }, 'Error di plugin handler');
      await reply('⚠️ Terjadi kesalahan saat menjalankan command.');
    }

    return;
  }

  // ─── Owner: intent detection dulu, fallback ke AI chat (sequential) ──
  // [Fix Bug 2 & 3 · Double-Reply Race Condition] Sebelumnya intent
  // detection dan AI chat dijalankan PARALEL, dengan guard `Promise.race`
  // untuk "mengintip" siapa selesai duluan — pola ini TIDAK RELIABLE di
  // JavaScript (meracing promise yang sudah settle melawan Promise.resolve()
  // baru tidak memberi jawaban pasti soal urutan penyelesaian, keduanya
  // sama-sama butuh microtask tick) DAN tidak bisa mencegah plugin
  // triggered mengirim reply-nya sendiri secara independen (lihat
  // interceptedReply di core/triggeredPluginHandler.js). Akibatnya user bisa
  // menerima 2 balasan untuk 1 pesan — salah satunya AI chat yang tidak tahu
  // apa-apa soal hasil eksekusi plugin nyata, sehingga bisa berhalusinasi
  // seolah suatu aksi (mis. transaksi keuangan) berhasil padahal tidak.
  //
  // Fix: SEQUENTIAL — intent detection dulu (dengan timeout wajar agar
  // deteksi yang macet/lambat tidak membuat bot diam total), baru fallback
  // ke AI chat jika tidak ada intent yang cocok. Trade-off yang disadari:
  // menambah latensi ke SEMUA pesan owner (bukan hanya yang butuh aksi
  // plugin), demi kebenaran (tidak akan pernah ada 2 balasan untuk 1 pesan).
  // replyGuard menutup celah residual: karena JS tidak punya cancellation,
  // promise handleTriggeredPlugin yang timeout tetap jalan di background —
  // jika ia baru selesai SETELAH kita mulai AI chat, reply-nya diabaikan.
  if (owner) {
    // Catat pesan teks natural owner ke chatHistory (dengan quote context jika ada)
    if (text.trim() || quotedText) {
      recordMessage({ jid, role: 'user', text: intentText, sender }).catch(() => {});
    }

    // Jika ada gambar/dokumen/video → deskripsikan dan simpan ke chatHistory (fire-and-forget)
    if (hasImage) {
      recordImageToHistory({ jid, sender, attachments: imageAttachments, caption: text }).catch(() => {});
    }
    if (hasDocument) {
      recordDocumentToHistory({ jid, sender, attachments: documentAttachments, caption: text }).catch(() => {});
    }
    if (socialResult) {
      recordSocialMediaToHistory({ jid, sender, attachment: socialResult.attachment, metadata: socialResult.metadata, url: socialUrl }).catch(() => {});
    }

    const ownerReplyGuard = { sent: false };
    const guardedReply = async (replyText) => {
      if (ownerReplyGuard.sent) {
        logger.warn({ sender: sender.split('@')[0] }, '⚠️ Intent plugin selesai setelah timeout & AI sudah reply — diabaikan (race-safety)');
        return;
      }
      await reply(replyText);
    };

    const ctx = { sock, msg, jid, sender, isOwner: owner, text: intentText, reply: guardedReply, attachments };
    const { prompt: systemPrompt } = getPersona(sender, owner);

    const intentHandled = await withTimeout(
      handleTriggeredPlugin(ctx).catch((err) => {
        logger.error({ sender, err: err.message }, 'Error di intent detection');
        return false;
      }),
      INTENT_DETECTION_TIMEOUT_MS,
      false
    );

    if (intentHandled) {
      // Plugin sudah mengirim reply-nya sendiri (via interceptedReply) — selesai.
      return;
    }

    // Tutup guard SEBELUM mulai AI chat — plugin yang selesai belakangan
    // (setelah timeout) tidak akan bisa ikut reply lagi.
    ownerReplyGuard.sent = true;

    const ownerContextHints = computeContextHints(sender, intentText);
    try {
      const segments = await askAISegmented({ jid: sender, userText: intentText, systemPrompt, attachments, contextHints: ownerContextHints });
      const fullText = segments.map((s) => s.text).join(' ');
      await replySegmented(sock, jid, segments, msg);
      recordMessage({ jid, role: 'bot', text: fullText, sender: 'bot' }).catch(() => {});
    } catch (err) {
      logger.error({ sender, err: err.message }, 'Error saat request ke AI');
      await reply('❌ Maaf, terjadi kesalahan. Coba lagi nanti.');
    }
    return;
  }

  // ─── Non-owner: cek approval, lalu AI chat ──────────────────────────
  // [Fitur 2 · Approval Owner]
  //   - Blocklist (pernah ditolak/timeout) → abaikan pesan sepenuhnya
  //   - Whitelist & belum expired → lanjut proses normal seperti sebelumnya
  //   - Belum ada status → mulai alur approval, TIDAK membalas sender
  if (approvalStore.isBlocked(sender)) {
    logger.debug({ sender: sender.split('@')[0] }, '🚫 approvalStore: sender diblokir, pesan diabaikan total');
    return;
  }

  if (!approvalStore.isWhitelisted(sender)) {
    await handleApprovalRequest({ sock, jid, sender, text: intentText, attachments });
    return;
  }

  // Whitelisted & belum expired → proses normal seperti alur AI chat biasa
  if (text.trim() || quotedText) {
    recordMessage({ jid, role: 'user', text: intentText, sender }).catch(() => {});
  }

  if (hasImage) {
    recordImageToHistory({ jid, sender, attachments: imageAttachments, caption: text }).catch(() => {});
  }
  if (hasDocument) {
    recordDocumentToHistory({ jid, sender, attachments: documentAttachments, caption: text }).catch(() => {});
  }
  if (socialResult) {
    recordSocialMediaToHistory({ jid, sender, attachment: socialResult.attachment, metadata: socialResult.metadata, url: socialUrl }).catch(() => {});
  }

  await sendAIReply({ sock, jid, sender, msg, text: intentText, attachments });
}
