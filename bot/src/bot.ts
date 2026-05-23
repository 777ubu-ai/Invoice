import { Bot, session } from 'grammy';
import { conversations, createConversation } from '@grammyjs/conversations';
import { env } from './config/env.js';
import type { BotContext, SessionData } from './types/context.js';

import { auth } from './middleware/auth.js';
import { logging } from './middleware/logging.js';
import { requireRole } from './middleware/role.js';

import { startHandler } from './handlers/common/start.handler.js';
import { menuHandler } from './handlers/common/menu.handler.js';
import { helpHandler } from './handlers/common/help.handler.js';
import { meHandler } from './handlers/common/me.handler.js';

import { listHandler } from './handlers/operator/list.handler.js';
import { historyHandler } from './handlers/operator/history.handler.js';
import { clientsHandler } from './handlers/operator/clients.handler.js';

import { teamHandler } from './handlers/manager/team.handler.js';
import { teamListHandler } from './handlers/manager/team-list.handler.js';
import { teamStatsHandler } from './handlers/manager/team-stats.handler.js';

import { adminHandler } from './handlers/owner/admin.handler.js';
import { allUsersHandler } from './handlers/owner/all-users.handler.js';
import { allInvoicesHandler } from './handlers/owner/all-invoices.handler.js';
import { broadcastHandler } from './handlers/owner/broadcast.handler.js';

import { newInvoiceConversation } from './conversations/new-invoice.conv.js';
import { addOperatorConversation } from './conversations/add-operator.conv.js';
import { addManagerConversation } from './conversations/add-manager.conv.js';
import { helpRequestConversation } from './conversations/help-request.conv.js';

import { callbacks } from './handlers/callbacks.js';
import { setBotApi } from './services/notifications.js';
import { logger } from './utils/logger.js';

export function buildBot(): Bot<BotContext> {
  // Если у нас поднят свой Local Bot API Server — направляем grammY на него.
  // Тогда лимит на скачивание файлов = 2 ГБ вместо 20 МБ.
  const clientConfig = env.TELEGRAM_API_ROOT
    ? { client: { apiRoot: env.TELEGRAM_API_ROOT } }
    : {};
  const bot = new Bot<BotContext>(env.TELEGRAM_BOT_TOKEN, clientConfig);
  if (env.TELEGRAM_API_ROOT) {
    logger.info({ apiRoot: env.TELEGRAM_API_ROOT }, 'using local Telegram Bot API server');
  }
  setBotApi(bot.api);

  bot.use(session<SessionData, BotContext>({ initial: () => ({}) }));

  // /cancel must escape an active conversation — clear conversation state before
  // the conversations() middleware has a chance to resume it.
  bot.use(async (ctx, next) => {
    const text = ctx.message?.text ?? '';
    if (text === '/cancel' || text.startsWith('/cancel ') || text.startsWith('/cancel@')) {
      delete (ctx.session as { conversation?: unknown }).conversation;
      await ctx.reply('✓ Диалог отменён. /menu — главное меню.');
      return;
    }
    await next();
  });

  bot.use(conversations());

  bot.use(createConversation(newInvoiceConversation, { id: 'newInvoice' }));
  bot.use(createConversation(addOperatorConversation, { id: 'addOperator' }));
  bot.use(createConversation(addManagerConversation, { id: 'addManager' }));
  bot.use(createConversation(helpRequestConversation, { id: 'helpRequest' }));

  bot.use(logging);
  bot.use(auth);

  bot.command('start', startHandler);
  bot.command('menu', menuHandler);
  bot.command('help', helpHandler);
  bot.command('me', meHandler);

  bot.command('list', requireRole('OPERATOR', 'MANAGER', 'OWNER'), listHandler);
  bot.command('history', requireRole('OPERATOR', 'MANAGER', 'OWNER'), historyHandler);
  bot.command('clients', requireRole('OPERATOR', 'MANAGER', 'OWNER'), clientsHandler);

  bot.command('new', requireRole('OPERATOR', 'MANAGER', 'OWNER'), async (ctx) => {
    await ctx.conversation.enter('newInvoice');
  });

  bot.command('help_manager', requireRole('OPERATOR'), async (ctx) => {
    await ctx.conversation.enter('helpRequest');
  });
  bot.command('help_owner', requireRole('MANAGER'), async (ctx) => {
    await ctx.conversation.enter('helpRequest');
  });

  bot.command('team', requireRole('MANAGER', 'OWNER'), teamHandler);
  bot.command('team_list', requireRole('MANAGER', 'OWNER'), teamListHandler);
  bot.command('team_stats', requireRole('MANAGER', 'OWNER'), teamStatsHandler);
  bot.command('add_operator', requireRole('MANAGER', 'OWNER'), async (ctx) => {
    await ctx.conversation.enter('addOperator');
  });

  bot.command('admin', requireRole('OWNER'), adminHandler);
  bot.command('all_users', requireRole('OWNER'), allUsersHandler);
  bot.command('all_invoices', requireRole('OWNER'), allInvoicesHandler);
  bot.command('add_manager', requireRole('OWNER'), async (ctx) => {
    await ctx.conversation.enter('addManager');
  });
  bot.command('broadcast', requireRole('OWNER'), broadcastHandler);

  bot.use(callbacks);

  bot.on('message', async (ctx) => {
    if (!ctx.dbUser) return;
    await ctx.reply('Не понял команду. /help — список команд.');
  });

  bot.catch((err) => {
    logger.error({ err: err.error, update: err.ctx?.update?.update_id }, 'bot error');
  });

  return bot;
}
