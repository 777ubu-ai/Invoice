import type { BotContext } from '../../types/context.js';
import { adminMenu } from '../../keyboards/admin.kb.js';

export async function adminHandler(ctx: BotContext): Promise<void> {
  await ctx.reply('🛠 Админ-меню:', { reply_markup: adminMenu() });
}
