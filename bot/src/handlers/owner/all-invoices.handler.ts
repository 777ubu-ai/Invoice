import type { BotContext } from '../../types/context.js';
import { listAll } from '../../services/invoices.repo.js';
import { invoiceShortLine } from '../../utils/format.js';

export async function allInvoicesHandler(ctx: BotContext): Promise<void> {
  const items = await listAll(30);
  if (items.length === 0) {
    await ctx.reply('Инвойсов пока нет.');
    return;
  }
  const lines = ['📊 Последние инвойсы:', ...items.map(invoiceShortLine)];
  await ctx.reply(lines.join('\n'));
}
