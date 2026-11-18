import { Bot, Keyboard, type Context } from 'grammy';
import { canAccess, type BotKind, type Role } from './access.js';
import { HOME, scopeText } from './menu.js';

export interface RoleStore { rolesFor(id: number): Promise<Role[]> }

export function createBot(token: string, kind: BotKind, store: RoleStore, ownerIds: readonly number[]) {
  const bot = new Bot<Context & { state: { roles: Role[] } }>(token);
  const name = kind === 'packing' ? 'Packing Bot' : 'Invoice Bot';
  const keyboard = new Keyboard().text(HOME.sections).row().text(HOME.access).text(HOME.help).resized();

  // All updates, including stale callbacks and uploaded files, pass this guard.
  bot.use(async (ctx, next) => {
    if (ctx.chat?.type !== 'private' || !ctx.from || ctx.from.is_bot) return;
    const roles: Role[] = ownerIds.includes(ctx.from.id) ? ['owner'] : await store.rolesFor(ctx.from.id);
    if (!canAccess(kind, roles)) {
      if (ctx.callbackQuery) await ctx.answerCallbackQuery({ text: 'Нет доступа', show_alert: true });
      else await ctx.reply(`Нет доступа к ${name}. Передайте руководителю ваш Telegram ID: ${ctx.from.id}.`, {
        reply_markup: { remove_keyboard: true },
      });
      return;
    }
    // No session or user-controlled role selection; roles are read for each update.
    ctx.state = { roles };
    await next();
  });

  bot.command(['start', 'menu'], ctx => ctx.reply(
    `${name} — новая версия.\nДоступ и структура отделов подключены. Обработка файлов, расчёты и выпуск документов ещё не подключены.`,
    { reply_markup: keyboard },
  ));
  bot.hears(HOME.sections, ctx => ctx.reply(scopeText(kind, ctx.state.roles as Role[])));
  const access = (id: number, roles: Role[]) => `Telegram ID: ${id}\nРоли: ${roles.join(', ')}\nБот: ${name}`;
  bot.command('me', ctx => ctx.reply(access(ctx.from!.id, ctx.state.roles as Role[])));
  bot.hears(HOME.access, ctx => ctx.reply(access(ctx.from!.id, ctx.state.roles as Role[])));
  const help = `${name}\n/menu — меню\n/me — мой доступ\n\nРабота только в личном чате. Для изменения прав обратитесь к руководителю.\nСтарые команды не выполняются. Файлы пока не принимаются; ничего не рассчитано и не выпущено.`;
  bot.command('help', ctx => ctx.reply(help));
  bot.hears(HOME.help, ctx => ctx.reply(help));
  bot.on('callback_query', ctx => ctx.answerCallbackQuery({ text: 'Старая кнопка недействительна. Откройте /menu.', show_alert: true }));
  bot.on('message', ctx => ctx.reply('Откройте /menu. Обработка файлов и документов ещё не подключена.'));
  return bot;
}
