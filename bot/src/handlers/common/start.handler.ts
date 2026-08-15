import type { BotContext } from '../../types/context.js';
import { findByUsername, bindTelegramId, findByTelegramId } from '../../services/users.repo.js';
import { audit } from '../../services/audit.repo.js';
import { mainMenu } from '../../keyboards/main-menu.kb.js';
import { logger } from '../../utils/logger.js';

const ROLE_TITLES: Record<string, string> = {
  OWNER: '👑 OWNER',
  MANAGER: '🎯 MANAGER',
  OPERATOR: '👤 OPERATOR',
};

export async function startHandler(ctx: BotContext): Promise<void> {
  const tgUser = ctx.from;
  if (!tgUser) return;

  // Already in DB and active.
  if (ctx.dbUser) {
    return greet(ctx);
  }

  // Try to find a pre-registered user by username (they were added by a manager
  // before they ever wrote to the bot, so telegram_user_id is null).
  if (tgUser.username) {
    const pending = await findByUsername(tgUser.username);
    if (pending && pending.is_active && pending.telegram_user_id === null) {
      await bindTelegramId(pending.id, tgUser.id);
      const refreshed = await findByTelegramId(tgUser.id);
      if (refreshed) {
        ctx.dbUser = refreshed;
        await audit({
          actor_user_id: refreshed.id,
          action: 'USER_BOUND',
          target_type: 'user',
          target_id: refreshed.id,
          payload: { telegram_user_id: tgUser.id, username: tgUser.username },
        });
        logger.info({ userId: refreshed.id }, 'user bound by username');
        return greet(ctx);
      }
    }
  }

  await ctx.reply(
    '❌ Этот бот для сотрудников TNVED.ai.\n' +
      `Если ты сотрудник — попроси своего руководителя добавить тебя по username @${
        tgUser.username ?? 'твой_username'
      }`,
  );
}

async function greet(ctx: BotContext): Promise<void> {
  const u = ctx.dbUser!;
  const roleTitle = ROLE_TITLES[u.role] ?? u.role;
  const clients = u.client_access.length > 0 ? u.client_access.join(', ') : '—';
  const teamLine = u.team_name ? `\nКоманда: ${u.team_name}` : '';

  await ctx.reply(
    `👋 Добро пожаловать в TNVED.ai!\n\n` +
      `Ты: ${u.full_name} (${roleTitle})${teamLine}\n` +
      `Доступные клиенты: ${clients}\n\n` +
      `Главное меню:`,
    { reply_markup: mainMenu(u.role) },
  );
}
