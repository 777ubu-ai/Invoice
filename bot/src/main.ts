import { buildBot } from './bot.js';
import { logger } from './utils/logger.js';
import { env } from './config/env.js';

async function main(): Promise<void> {
  const bot = buildBot();

  const me = await bot.api.getMe();
  logger.info({ username: me.username, id: me.id, env: env.NODE_ENV }, 'bot starting');

  // Long polling. Webhook deferred to Sprint 3 follow-up.
  bot.start({
    onStart: (info) => logger.info({ username: info.username }, 'bot ready'),
    drop_pending_updates: true,
  });

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'shutting down');
    await bot.stop();
    process.exit(0);
  };

  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  logger.fatal({ err }, 'bot crashed on startup');
  process.exit(1);
});
