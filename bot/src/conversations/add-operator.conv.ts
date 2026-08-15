import { InlineKeyboard } from 'grammy';
import type { BotContext, BotConversation } from '../types/context.js';
import { api } from '../services/api.js';
import { createUser, findByUsername } from '../services/users.repo.js';
import { audit } from '../services/audit.repo.js';

export async function addOperatorConversation(
  conversation: BotConversation,
  ctx: BotContext,
): Promise<void> {
  const manager = ctx.dbUser;
  if (!manager) return;

  await ctx.reply('Введи username нового оператора (например @ivan_dev):');
  const unameMsg = await conversation.waitFor(':text');
  const usernameRaw = unameMsg.message?.text?.trim() ?? '';
  const username = usernameRaw.replace(/^@/, '').toLowerCase();
  if (!/^[a-z0-9_]{4,32}$/.test(username)) {
    await ctx.reply('Не похоже на Telegram username. Отменено.');
    return;
  }

  const existing = await findByUsername(username);
  if (existing && existing.is_active) {
    await ctx.reply(`@${username} уже в системе как ${existing.role}.`);
    return;
  }

  await ctx.reply('Имя оператора (как обращаться):');
  const nameMsg = await conversation.waitFor(':text');
  const fullName = (nameMsg.message?.text ?? '').trim().slice(0, 80);
  if (!fullName) {
    await ctx.reply('Имя пустое. Отменено.');
    return;
  }

  // Determine clients: if OWNER, can pick any; if MANAGER, only from their accessible set.
  const allClients = await api.listClients();
  const offered = manager.role === 'OWNER' || manager.client_access.includes('*')
    ? [...allClients, 'Все клиенты проекта']
    : manager.client_access;

  const kb = new InlineKeyboard();
  for (const c of offered) {
    kb.text(c, `addop:client:${encodeURIComponent(c)}`).row();
  }
  await ctx.reply('К каким клиентам у него доступ?', { reply_markup: kb });

  const choice = await conversation.waitFor('callback_query:data');
  await choice.answerCallbackQuery();
  const m = choice.callbackQuery.data.match(/^addop:client:(.+)$/);
  if (!m) {
    await ctx.reply('Не понял выбор. Отменено.');
    return;
  }
  const picked = decodeURIComponent(m[1]!);
  const clientAccess =
    picked === 'Все клиенты проекта' ? allClients : [picked];

  const created = await createUser({
    telegram_username: username,
    full_name: fullName,
    role: 'OPERATOR',
    manager_id: manager.id,
    team_name: manager.team_name,
    client_access: clientAccess,
    added_by: manager.id,
  });

  await audit({
    actor_user_id: manager.id,
    action: 'OPERATOR_ADDED',
    target_type: 'user',
    target_id: created.id,
    payload: { username, full_name: fullName, client_access: clientAccess },
  });

  await ctx.reply(
    `✅ ${fullName} добавлен(а) в команду.\n` +
      `Доступ: ${clientAccess.join(', ')}\n` +
      `Роль: OPERATOR\n\n` +
      `Передай @${username} команду /start`,
  );
}
