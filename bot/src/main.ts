import { buildBot } from './bot.js';
import { logger } from './utils/logger.js';
import { env } from './config/env.js';

async function main(): Promise<void> {
  const bot = buildBot();

  const me = await bot.api.getMe();
  logger.info({ username: me.username, id: me.id, env: env.NODE_ENV }, 'bot starting');

  // Drop any prior webhook (e.g. from the Supabase Edge Function) so long
  // polling can take over without 409 Conflict.
  try {
    await bot.api.deleteWebhook({ drop_pending_updates: true });
    logger.info('webhook cleared, switching to long polling');
  } catch (err) {
    logger.warn({ err }, 'deleteWebhook failed (continuing anyway)');
  }

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
