import type { BotContext } from '../../types/context.js';
import { listAllUsers } from '../../services/users.repo.js';
import { notifyUser } from '../../services/notifications.js';
import { audit } from '../../services/audit.repo.js';

export async function broadcastHandler(ctx: BotContext): Promise<void> {
  const text = (ctx.message?.text ?? '').replace(/^\/broadcast(@\S+)?\s*/, '').trim();
  if (!text) {
    await ctx.reply('Использование: /broadcast <текст>\nПример: /broadcast Завтра в 10:00 общий созвон');
    return;
  }

  const users = await listAllUsers();
  let sent = 0;
  for (const u of users) {
    if (!u.is_active || u.telegram_user_id == null) continue;
    if (ctx.dbUser && u.id === ctx.dbUser.id) continue;
    await notifyUser(Number(u.telegram_user_id), `📢 ${text}`);
    sent++;
  }
  await audit({
    actor_user_id: ctx.dbUser?.id ?? null,
    action: 'BROADCAST',
    payload: { text, recipients: sent },
  });
  await ctx.reply(`✅ Рассылка отправлена ${sent} сотрудникам.`);
}
