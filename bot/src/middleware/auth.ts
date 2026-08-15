import type { MiddlewareFn } from 'grammy';
import type { BotContext } from '../types/context.js';
import { findByTelegramId, touchLastActive } from '../services/users.repo.js';
import { logger } from '../utils/logger.js';

/**
 * Looks up the Telegram user in the database. Attaches dbUser to the context.
 * If the user is not registered, replies with a rejection and stops the chain.
 *
 * Whitelist of commands that work for unknown users.
 */
const ANONYMOUS_COMMANDS = new Set(['/start', '/help']);

export const auth: MiddlewareFn<BotContext> = async (ctx, next) => {
  const from = ctx.from;
  if (!from) return next();

  const text = ctx.message?.text ?? '';
  const isAnonAllowed = ANONYMOUS_COMMANDS.has(text.split(/\s+/)[0] ?? '');

  try {
    const user = await findByTelegramId(from.id);
    if (user && user.is_active) {
      ctx.dbUser = user;
      touchLastActive(user.id).catch((err) =>
        logger.warn({ err, userId: user.id }, 'touchLastActive failed'),
      );
      return next();
    }

    if (isAnonAllowed) {
      // Let /start handler reject with a friendly message.
      return next();
    }

    await ctx.reply(
      '❌ Этот бот для сотрудников TNVED.ai.\n' +
        'Если ты сотрудник — попроси своего руководителя добавить тебя по username.',
    );
  } catch (err) {
    logger.error({ err, telegramUserId: from.id }, 'auth middleware error');
    await ctx.reply('Сервис временно недоступен, попробуй через минуту.');
  }
};
