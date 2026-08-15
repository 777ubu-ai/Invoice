import type { BotContext } from '../../types/context.js';
import { listAllUsers } from '../../services/users.repo.js';

const ROLE_ICON: Record<string, string> = {
  OWNER: '👑',
  MANAGER: '🎯',
  OPERATOR: '👤',
};

export async function allUsersHandler(ctx: BotContext): Promise<void> {
  const users = await listAllUsers();
  if (users.length === 0) {
    await ctx.reply('Нет пользователей.');
    return;
  }
  const lines = ['👥 Все пользователи:'];
  for (const u of users) {
    const icon = ROLE_ICON[u.role] ?? '•';
    const status = u.is_active ? '' : ' (неактивен)';
    const uname = u.telegram_username ? ` @${u.telegram_username}` : '';
    lines.push(`${icon} ${u.full_name}${uname} — ${u.role}${status}`);
  }
  await ctx.reply(lines.join('\n'));
}
