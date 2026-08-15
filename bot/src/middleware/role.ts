import type { MiddlewareFn } from 'grammy';
import type { BotContext } from '../types/context.js';
import type { Role } from '../types/user.js';
import { audit } from '../services/audit.repo.js';

export function requireRole(...allowed: Role[]): MiddlewareFn<BotContext> {
  return async (ctx, next) => {
    if (!ctx.dbUser) {
      await ctx.reply('Сначала авторизуйся: /start');
      return;
    }
    if (!allowed.includes(ctx.dbUser.role)) {
      await ctx.reply('🚫 Недостаточно прав для этой команды.');
      await audit({
        actor_user_id: ctx.dbUser.id,
        action: 'ACCESS_DENIED',
        target_type: 'command',
        payload: {
          text: ctx.message?.text ?? null,
          required: allowed,
          actor_role: ctx.dbUser.role,
        },
      });
      return;
    }
    return next();
  };
}
