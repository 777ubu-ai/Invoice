import type { BotContext } from '../../types/context.js';
import { listOperatorsByManager } from '../../services/users.repo.js';
import { teamKeyboard } from '../../keyboards/team.kb.js';

export async function teamHandler(ctx: BotContext): Promise<void> {
  const m = ctx.dbUser;
  if (!m) return;
  const team = await listOperatorsByManager(m.id);
  const head = team.length === 0 ? '👥 В твоей команде пока никого нет.' : `👥 Твоя команда (${team.length}):`;
  const body = team
    .map((op) => {
      const clients = op.client_access.join(', ') || '—';
      return `• ${op.full_name} (${clients}) — ${op.is_active ? 'активен' : 'неактивен'}`;
    })
    .join('\n');
  await ctx.reply([head, body].filter(Boolean).join('\n'), {
    reply_markup: teamKeyboard(team),
  });
}
