import type { BotContext } from '../../types/context.js';

const ROLE_TITLES: Record<string, string> = {
  OWNER: '👑 OWNER',
  MANAGER: '🎯 MANAGER',
  OPERATOR: '👤 OPERATOR',
};

export async function meHandler(ctx: BotContext): Promise<void> {
  const u = ctx.dbUser;
  if (!u) return;
  const clients = u.client_access.length > 0 ? u.client_access.join(', ') : '—';
  const teamLine = u.team_name ? `\nКоманда: ${u.team_name}` : '';
  const conf = u.avg_confidence != null ? `${u.avg_confidence}%` : '—';

  await ctx.reply(
    `Ты: ${u.full_name}\n` +
      `Роль: ${ROLE_TITLES[u.role] ?? u.role}${teamLine}\n` +
      `Доступные клиенты: ${clients}\n\n` +
      `📊 Статистика:\n` +
      `Всего инвойсов: ${u.invoices_total}\n` +
      `За этот месяц: ${u.invoices_this_month}\n` +
      `Средняя уверенность: ${conf}`,
  );
}
