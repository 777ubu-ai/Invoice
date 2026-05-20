import type { BotContext } from '../../types/context.js';
import { api } from '../../services/api.js';

export async function clientsHandler(ctx: BotContext): Promise<void> {
  const u = ctx.dbUser;
  if (!u) return;
  const list = u.client_access.includes('*') ? await api.listClients() : u.client_access;
  if (list.length === 0) {
    await ctx.reply('👥 Тебе не назначен ни один клиент. Попроси руководителя.');
    return;
  }
  await ctx.reply(`👥 Доступные клиенты:\n${list.map((c) => `• ${c}`).join('\n')}`);
}
