// plugins/ai.js
import { askAI, resetSession } from '../services/aiService.js';
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

    const systemPrompt = owner ? config.ownerPersona : config.regularPersona;
    const aiReply = await askAI({ jid: sender, userText: fullArgs, systemPrompt });
    await reply(aiReply);
  },
};

export default plugin;
