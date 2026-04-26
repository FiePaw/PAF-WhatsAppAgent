// plugins/reset.js
import { resetSession } from '../services/aiService.js';

const plugin = {
  name: 'Reset Session',
  description: 'Reset percakapan AI (mulai dari awal)',
  commands: ['reset', 'clear'],
  ownerOnly: false,

  handler: async ({ sender, reply }) => {
    await resetSession(sender);
    await reply('🔄 Percakapan AI kamu sudah direset. Mulai obrolan baru yuk!');
  },
};

export default plugin;
