import type { BotContext, BotConversation } from '../types/context.js';
import { createUser, findByUsername } from '../services/users.repo.js';
import { audit } from '../services/audit.repo.js';

export async function addManagerConversation(
  conversation: BotConversation,
  ctx: BotContext,
): Promise<void> {
  const owner = ctx.dbUser;
  if (!owner || owner.role !== 'OWNER') return;

  await ctx.reply('Username будущего руководителя:');
  const unameMsg = await conversation.waitFor(':text');
  const username = (unameMsg.message?.text ?? '').trim().replace(/^@/, '').toLowerCase();
  if (!/^[a-z0-9_]{4,32}$/.test(username)) {
    await ctx.reply('Не похоже на Telegram username. Отменено.');
    return;
  }

  const existing = await findByUsername(username);
  if (existing && existing.is_active) {
    await ctx.reply(`@${username} уже в системе как ${existing.role}.`);
    return;
  }

  await ctx.reply('Имя:');
  const nameMsg = await conversation.waitFor(':text');
  const fullName = (nameMsg.message?.text ?? '').trim().slice(0, 80);
  if (!fullName) {
    await ctx.reply('Имя пустое. Отменено.');
    return;
  }

  await ctx.reply('Название направления/проекта (например: «Импорт сантехники из Китая»):');
  const projMsg = await conversation.waitFor(':text');
  const teamName = (projMsg.message?.text ?? '').trim().slice(0, 120);

  const created = await createUser({
    telegram_username: username,
    full_name: fullName,
    role: 'MANAGER',
    team_name: teamName || null,
    client_access: ['*'],
    added_by: owner.id,
  });

  await audit({
    actor_user_id: owner.id,
    action: 'MANAGER_ADDED',
    target_type: 'user',
    target_id: created.id,
    payload: { username, full_name: fullName, team_name: teamName },
  });

  await ctx.reply(
    `✅ ${fullName} назначен(а) MANAGER\n` +
      (teamName ? `Проект: «${teamName}»\n` : '') +
      `\nТеперь он(а) может добавлять операторов командой /add_operator.\n` +
      `Передай @${username} команду /start.`,
  );
}
