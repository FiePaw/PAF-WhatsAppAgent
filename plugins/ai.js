// plugins/ai.js
import { askAI } from '../services/aiService.js';
import { getPersona } from '../services/personaService.js';
import config from '../config/config.js';

const plugin = {
  name: 'AI Chat',
  description: 'Tanya AI dengan command eksplisit',
  commands: ['ai', 'ask', 'tanya'],
  ownerOnly: false,

  handler: async ({ sender, isOwner: owner, fullArgs, reply }) => {
    if (!fullArgs.trim()) {
      await reply(`💬 Gunakan: *${config.botPrefix}ai [pertanyaan kamu]*\n\nContoh: \`${config.botPrefix}ai siapa presiden indonesia?\``);
      return;
    }

    // Bug fix: config.ownerPersona/regularPersona sudah tidak ada sejak
    // migrasi persona ke config/persona.json (personaService) — pakai
    // sumber yang sama dengan alur chat biasa agar konsisten.
    const { prompt: systemPrompt } = getPersona(sender, owner);
    const aiReply = await askAI({ jid: sender, userText: fullArgs, systemPrompt });
    await reply(aiReply);
  },
};

export default plugin;
