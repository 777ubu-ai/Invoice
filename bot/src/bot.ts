import { Bot, session } from 'grammy';
import { env } from './config/env.js';
import type { BotContext, SessionData } from './types/context.js';
import { auth } from './middleware/auth.js';
import { logging } from './middleware/logging.js';
import { startHandler } from './handlers/common/start.handler.js';
import { menuHandler } from './handlers/common/menu.handler.js';
import { helpHandler } from './handlers/common/help.handler.js';
import { meHandler } from './handlers/common/me.handler.js';
import { cancelHandler } from './handlers/common/cancel.handler.js';

export function buildBot(): Bot<BotContext> {
  const bot = new Bot<BotContext>(env.TELEGRAM_BOT_TOKEN);

  bot.use(
    session<SessionData, BotContext>({
      initial: () => ({}),
    }),
  );

  bot.use(logging);
  bot.use(auth);

  bot.command('start', startHandler);
  bot.command('menu', menuHandler);
  bot.command('help', helpHandler);
  bot.command('me', meHandler);
  bot.command('cancel', cancelHandler);

  // Placeholder handlers for commands that need API / further work.
  bot.command(
    ['new', 'list', 'history', 'clients', 'help_manager'],
    async (ctx) => {
      await ctx.reply('🚧 Эта команда будет реализована в следующем шаге спринта.');
    },
  );
  bot.command(
    ['team', 'team_list', 'team_stats', 'add_operator', 'help_owner'],
    async (ctx) => {
      await ctx.reply('🚧 Эта команда будет реализована в следующем шаге спринта.');
    },
  );
  bot.command(
    ['admin', 'add_manager', 'all_users', 'all_invoices', 'broadcast'],
    async (ctx) => {
      await ctx.reply('🚧 Эта команда будет реализована в следующем шаге спринта.');
    },
  );

  bot.on('callback_query:data', async (ctx) => {
    await ctx.answerCallbackQuery('🚧 Обработчик появится в следующем шаге.');
  });

  bot.catch((err) => {
    // Global error handler logs through pino; user-visible message already sent.
    // eslint-disable-next-line no-console
    console.error('Bot error:', err);
  });

  return bot;
}
