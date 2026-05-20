import { InlineKeyboard } from 'grammy';
import type { BotContext } from '../../types/context.js';
import { listTeamActive } from '../../services/invoices.repo.js';
import { supabase } from '../../services/supabase.js';
import { invoiceShortLine } from '../../utils/format.js';

export async function teamListHandler(ctx: BotContext): Promise<void> {
  const m = ctx.dbUser;
  if (!m) return;
  const items = await listTeamActive(m.id);
  if (items.length === 0) {
    await ctx.reply('📋 У команды нет активных задач.');
    return;
  }
  const assigneeIds = Array.from(new Set(items.map((i) => i.assigned_to).filter(Boolean) as string[]));
  const nameMap = new Map<string, string>();
  if (assigneeIds.length > 0) {
    const { data } = await supabase
      .from('telegram_users')
      .select('id, full_name')
      .in('id', assigneeIds);
    for (const u of data ?? []) nameMap.set(u.id, u.full_name);
  }
  const kb = new InlineKeyboard();
  const lines: string[] = ['📋 В работе у команды:'];
  for (const inv of items) {
    const name = inv.assigned_to ? nameMap.get(inv.assigned_to) ?? 'неизв.' : 'неизв.';
    lines.push(`${invoiceShortLine(inv)} — ${name}`);
    kb.text(`↪️ #${inv.invoice_number ?? inv.id.slice(0, 8)}`, `team:open:${inv.id}`).row();
  }
  await ctx.reply(lines.join('\n'), { reply_markup: kb });
}
