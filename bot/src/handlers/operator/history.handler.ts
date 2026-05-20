import type { BotContext } from '../../types/context.js';
import { listAssignedHistory } from '../../services/invoices.repo.js';
import { invoiceShortLine } from '../../utils/format.js';

export async function historyHandler(ctx: BotContext): Promise<void> {
  if (!ctx.dbUser) return;
  const items = await listAssignedHistory(ctx.dbUser.id);
  if (items.length === 0) {
    await ctx.reply('📜 Истории пока нет.');
    return;
  }
  const lines = ['📜 Завершённые:', ...items.map(invoiceShortLine)];
  await ctx.reply(lines.join('\n'));
}
