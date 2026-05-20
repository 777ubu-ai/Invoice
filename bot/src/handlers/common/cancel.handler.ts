import type { BotContext } from '../../types/context.js';

export async function cancelHandler(ctx: BotContext): Promise<void> {
  // Conversations will be added in a later step; for now this is a no-op confirmation.
  await ctx.reply('✓ Диалог отменён. Возвращаемся в главное меню. Команда /menu');
}
