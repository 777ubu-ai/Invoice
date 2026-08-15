import type { BotContext } from '../../types/context.js';
import { mainMenu } from '../../keyboards/main-menu.kb.js';

export async function menuHandler(ctx: BotContext): Promise<void> {
  if (!ctx.dbUser) return;
  await ctx.reply('Главное меню:', { reply_markup: mainMenu(ctx.dbUser.role) });
}
