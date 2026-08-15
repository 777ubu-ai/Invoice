import type { BotContext } from '../../types/context.js';
import { listAssignedActive } from '../../services/invoices.repo.js';
import { invoiceShortLine } from '../../utils/format.js';

export async function listHandler(ctx: BotContext): Promise<void> {
  if (!ctx.dbUser) return;
  const items = await listAssignedActive(ctx.dbUser.id);
  if (items.length === 0) {
    await ctx.reply('📋 Активных задач нет. /new — создать инвойс.');
    return;
  }
  const lines = ['📋 В работе:', ...items.map(invoiceShortLine)];
  await ctx.reply(lines.join('\n'));
}
