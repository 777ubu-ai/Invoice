import { Bot, InputFile, Keyboard, type Context } from 'grammy';
import { canAccess, canPrepareInvoice, type BotKind, type Role } from './access.js';
import { HOME, scopeText } from './menu.js';
import { findPrices, pricesMessage } from './tariffs.js';
import { CURRENCIES, createDraft, dateField, draftWorkbook, money, parseItems, valueField, type Draft, type InvoiceDraftStore } from './invoice-draft.js';
import { companySummary, type CompanyProfile } from './company-profile.js';
import { registerPackingWorkflow } from './packing-workflow.js';
import type { PackingJobs } from './packing-invoice.js';

export interface RoleStore { rolesFor(id: number): Promise<Role[]> }

type Stage = 'number'|'date'|'seller'|'currency'|'items'|'confirm'|'saving';
type Session = {stage: Stage; profile: CompanyProfile; number?: string; date?: string; seller?: string; currency?: string; draft?: Draft};

export function createBot(token: string, kind: BotKind, store: RoleStore, ownerIds: readonly number[], gridPath = '', invoiceStore?: InvoiceDraftStore, loadBuyer: () => Promise<CompanyProfile> = async () => { throw new Error('profile_missing'); }, packingJobs?: PackingJobs) {
  const bot = new Bot<Context & { state: { roles: Role[] } }>(token);
  const name = kind === 'packing' ? 'Packing Bot' : 'Invoice Bot';
  const keyboard = (roles: Role[]) => {
    const k = new Keyboard();
    if (kind === 'invoice' && canPrepareInvoice(roles)) k.text(HOME.newInvoice).row();
    if (kind === 'invoice') k.text(HOME.company).row();
    return k.text(HOME.sections).row().text(HOME.access).text(HOME.help).resized();
  };

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
    kind === 'invoice' ? 'Invoice Bot. Нажмите «Новый инвойс» и отправьте packing в формате XLSX.' : 'Packing Bot — разделы в разработке.',
    { reply_markup: keyboard(ctx.state.roles) },
  ));
  if (kind === 'invoice') {
    registerPackingWorkflow(bot, token, packingJobs, loadBuyer);
    const showCompany = async (ctx: Context) => {
      try { await ctx.reply(companySummary(await loadBuyer())); }
      catch { await ctx.reply('Реквизиты покупателя не найдены. Обратитесь к руководителю.'); }
    };
    bot.hears(HOME.company, showCompany);
    bot.command('company', showCompany);

  }
  bot.hears(HOME.sections, ctx => ctx.reply(scopeText(kind, ctx.state.roles as Role[])));
  const access = (id: number, roles: Role[]) => `Telegram ID: ${id}\nРоли: ${roles.join(', ')}\nБот: ${name}`;
  bot.command('me', ctx => ctx.reply(access(ctx.from!.id, ctx.state.roles as Role[])));
  bot.hears(HOME.access, ctx => ctx.reply(access(ctx.from!.id, ctx.state.roles as Role[])));
  const help = `${name}\n/menu — меню\n/me — мой доступ\n${kind === 'invoice' ? '/new — новый инвойс из packing XLSX\n/company — реквизиты покупателя\n/review — проверка и исправления\n/approve — сформировать Excel после проверки\n/cancel — отмена\n' : ''}`;
  bot.command('help', ctx => ctx.reply(help));
  bot.hears(HOME.help, ctx => ctx.reply(help));
  bot.on('callback_query', async ctx => {
    let cleared = false;
    try {
      if (ctx.callbackQuery.message) { await ctx.editMessageReplyMarkup({reply_markup:{inline_keyboard:[]}}); cleared = true; }
    } catch { /* Telegram may no longer permit editing this historical message. */ }
    await ctx.answerCallbackQuery({ text: cleared ? 'Старые кнопки убраны. Откройте /menu.' : 'Старая кнопка недействительна. Откройте /menu.', show_alert: true });
  });
  bot.on('message', ctx => ctx.reply('Откройте /menu.'));
  return bot;
}
