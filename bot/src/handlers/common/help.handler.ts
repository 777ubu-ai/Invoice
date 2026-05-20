import type { BotContext } from '../../types/context.js';

const COMMON = `
*Общие команды:*
/start \\- авторизация
/menu \\- главное меню
/new \\- создать инвойс
/list \\- мои задачи
/history \\- завершённые инвойсы
/me \\- информация обо мне
/cancel \\- отменить диалог
/help \\- эта справка
`;

const OPERATOR = `
*Для OPERATOR:*
/clients \\- мои клиенты
/help\\_manager \\- запрос помощи у MANAGER
`;

const MANAGER = `
*Для MANAGER:*
/team \\- управление командой
/team\\_list \\- инвойсы команды
/team\\_stats \\- KPI операторов
/add\\_operator \\- добавить оператора
/help\\_owner \\- запрос помощи у OWNER
`;

const OWNER = `
*Для OWNER:*
/admin \\- админ\\-меню
/add\\_manager \\- назначить MANAGER
/all\\_users \\- все пользователи
/all\\_invoices \\- все инвойсы
/broadcast \\- рассылка
`;

export async function helpHandler(ctx: BotContext): Promise<void> {
  const role = ctx.dbUser?.role;
  const parts = [COMMON];
  if (role === 'OPERATOR' || role === 'MANAGER' || role === 'OWNER') parts.push(OPERATOR);
  if (role === 'MANAGER' || role === 'OWNER') parts.push(MANAGER);
  if (role === 'OWNER') parts.push(OWNER);
  await ctx.reply(parts.join('\n'), { parse_mode: 'MarkdownV2' });
}
