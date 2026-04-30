// index.js
import 'dotenv/config';
import { startBot } from './core/bot.js';
import logger from './utils/logger.js';

logger.info('🚀 Memulai WhatsApp AI Bot...');

startBot().catch((err) => {
  logger.fatal({ err: err.message }, '💥 Fatal error saat start bot');
  process.exit(1);
});

// Graceful shutdown
process.on('SIGINT', () => {
  logger.info('👋 Bot dihentikan (SIGINT)');
  process.exit(0);
});

process.on('SIGTERM', () => {
  logger.info('👋 Bot dihentikan (SIGTERM)');
  process.exit(0);
});

process.on('unhandledRejection', (reason) => {
  logger.error({ reason }, '⚠️ Unhandled Promise Rejection');
});
