import type { BotContext } from '../../types/context.js';
import { listOperatorsByManager } from '../../services/users.repo.js';

export async function teamStatsHandler(ctx: BotContext): Promise<void> {
  const m = ctx.dbUser;
  if (!m) return;
  const team = await listOperatorsByManager(m.id);
  if (team.length === 0) {
    await ctx.reply('📊 В команде пока нет операторов.');
    return;
  }
  const lines = ['📊 Статистика команды:'];
  for (const op of team) {
    const conf = op.avg_confidence != null ? `${op.avg_confidence}%` : '—';
    lines.push(
      `• ${op.full_name}: всего ${op.invoices_total}, в этом месяце ${op.invoices_this_month}, ср. уверенность ${conf}`,
    );
  }
  await ctx.reply(lines.join('\n'));
}
