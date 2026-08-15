import type { MiddlewareFn } from 'grammy';
import type { BotContext } from '../types/context.js';
import { logger } from '../utils/logger.js';

export const logging: MiddlewareFn<BotContext> = async (ctx, next) => {
  const start = Date.now();
  const text = ctx.message?.text ?? ctx.callbackQuery?.data ?? '';
  try {
    await next();
  } finally {
    logger.info(
      {
        from: ctx.from?.id,
        username: ctx.from?.username,
        kind: ctx.message ? 'message' : ctx.callbackQuery ? 'callback' : 'other',
        text: text.slice(0, 100),
        ms: Date.now() - start,
      },
      'update handled',
    );
  }
};
