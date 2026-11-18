import { Bot, InputFile, Keyboard, type Context } from 'grammy';
import { canAccess, canPrepareInvoice, type BotKind, type Role } from './access.js';
import { HOME, scopeText } from './menu.js';
import { findPrices, pricesMessage } from './tariffs.js';
import { CURRENCIES, createDraft, dateField, draftWorkbook, money, parseItems, valueField, type Draft, type InvoiceDraftStore } from './invoice-draft.js';
import { companySummary, type CompanyProfile } from './company-profile.js';

export interface RoleStore { rolesFor(id: number): Promise<Role[]> }

type Stage = 'number'|'date'|'seller'|'currency'|'items'|'confirm'|'saving';
type Session = {stage: Stage; profile: CompanyProfile; number?: string; date?: string; seller?: string; currency?: string; draft?: Draft};

export function createBot(token: string, kind: BotKind, store: RoleStore, ownerIds: readonly number[], gridPath = '', invoiceStore?: InvoiceDraftStore, loadBuyer: () => Promise<CompanyProfile> = async () => { throw new Error('profile_missing'); }) {
  const bot = new Bot<Context & { state: { roles: Role[] } }>(token);
  const name = kind === 'packing' ? 'Packing Bot' : 'Invoice Bot';
  const keyboard = (roles: Role[]) => {
    const k = new Keyboard();
    if (kind === 'invoice' && canPrepareInvoice(roles)) k.text(HOME.newInvoice).row().text(HOME.grid).row();
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
    `${name} — новая версия.\nДоступны ручной черновик и поиск по сетке. Автоматическая обработка файлов, расчёт платежей и выпуск документов ещё не подключены.`,
    { reply_markup: keyboard(ctx.state.roles) },
  ));
  if (kind === 'invoice') {
    const sessions = new Map<number, Session>();
    const startDraft = async (ctx: Context & {state: {roles: Role[]}}) => {
      if (!canPrepareInvoice(ctx.state.roles)) { await ctx.reply('Нет доступа к созданию инвойса.'); return; }
      if (!invoiceStore) { await ctx.reply('Создание черновиков ещё не настроено.'); return; }
      let profile: CompanyProfile;
      try { profile = await loadBuyer(); }
      catch { await ctx.reply('Реквизиты покупателя не найдены. Обратитесь к руководителю.'); return; }
      sessions.set(ctx.from!.id, {stage:'number',profile});
      await ctx.reply(`Создаём черновик инвойса вручную. Покупатель и получатель: ${profile.name}. Документ не является выпущенным инвойсом.\nВведите номер инвойса. Отмена: /cancel`);
    };
    bot.hears(HOME.newInvoice, startDraft);
    bot.command('invoice', startDraft);
    bot.command('cancel', async ctx => { sessions.delete(ctx.from!.id); await ctx.reply('Черновик ввода отменён.'); });
    bot.command('save', async ctx => {
      const id = ctx.from!.id, s = sessions.get(id);
      if (!canPrepareInvoice(ctx.state.roles)) { sessions.delete(id); await ctx.reply('Нет доступа к созданию инвойса.'); return; }
      if (!s || s.stage !== 'confirm' || !s.draft || !invoiceStore) { await ctx.reply('Нет черновика, готового к сохранению.'); return; }
      s.stage = 'saving';
      try {
        const workbook = await draftWorkbook(s.draft);
        await invoiceStore.saveDraft(s.draft);
        await ctx.replyWithDocument(new InputFile(workbook, 'invoice-draft.xlsx'), {caption:'Черновик сохранён. Проверьте реквизиты, договор, условия оплаты и поставки. Выпуск готового инвойса ещё не подключён.'});
        sessions.delete(id);
      } catch {
        s.stage = 'confirm';
        await ctx.reply('Не удалось завершить сохранение или отправку. Повторите /save; черновик не будет продублирован.');
      }
    });
    const hint = 'Для поиска точного кода отправьте команду, например: /price 3916100000';
    bot.hears(HOME.grid, ctx => ctx.reply(canPrepareInvoice(ctx.state.roles) ? hint : 'Нет доступа к сетке.'));
    bot.command('price', async ctx => {
      if (!canPrepareInvoice(ctx.state.roles)) { await ctx.reply('Нет доступа к сетке.'); return; }
      const code = String(ctx.match).trim();
      if (!/^\d{10}$/.test(code)) { await ctx.reply(hint); return; }
      if (!gridPath) { await ctx.reply('Сетка ещё не подключена. Обратитесь к руководителю.'); return; }
      try { await ctx.reply(pricesMessage(code, await findPrices(gridPath, code))); }
      catch { await ctx.reply('Не удалось прочитать сетку. Обратитесь к руководителю.'); }
    });
    const showCompany = async (ctx: Context) => {
      try { await ctx.reply(companySummary(await loadBuyer())); }
      catch { await ctx.reply('Реквизиты покупателя не найдены. Обратитесь к руководителю.'); }
    };
    bot.hears(HOME.company, showCompany);
    bot.command('company', showCompany);
    bot.on('message:text', async (ctx, next) => {
      const id = ctx.from.id, session = sessions.get(id);
      if (!session) { await next(); return; }
      if (!canPrepareInvoice(ctx.state.roles)) { sessions.delete(id); await ctx.reply('Нет доступа к созданию инвойса.'); return; }
      const input = ctx.message.text.trim();
      if ([HOME.sections, HOME.access, HOME.help].includes(input as typeof HOME.sections)) { await next(); return; }
      if (input.startsWith('/')) { await ctx.reply('Завершите ввод или используйте /cancel. Для сохранения после проверки — /save.'); return; }
      try {
        switch (session.stage) {
          case 'number': session.number = valueField(input,80); session.stage = 'date'; await ctx.reply('Введите дату инвойса в формате ГГГГ-ММ-ДД, например 2026-11-18.'); break;
          case 'date': session.date = dateField(input); session.stage = 'seller'; await ctx.reply('Введите наименование продавца.'); break;
          case 'seller': session.seller = valueField(input); session.stage = 'currency'; await ctx.reply(`Покупатель / получатель: ${session.profile.name}.\nВведите валюту: USD, EUR, RUB, KZT или CNY.`); break;
          case 'currency':
            if (!CURRENCIES.includes(input.toUpperCase() as typeof CURRENCIES[number])) throw new Error('currency');
            session.currency = input.toUpperCase(); session.stage = 'items';
            await ctx.reply('Отправьте товары одним сообщением, по одной строке:\nНаименование | Количество | Единица | Цена за единицу\n\nПример:\nКоробка | 10 | шт | 2.50\n\nУкажите договорную цену; сетка не подставляется автоматически.'); break;
          case 'items': {
            const items = parseItems(input);
            session.draft = createDraft(id,{number:session.number!,date:session.date!,seller:session.seller!,buyer:session.profile.name,buyerDetails:session.profile,currency:session.currency!,items});
            session.stage = 'confirm';
            const d = session.draft;
            const rows = d.items.slice(0,10).map((x,i)=>`${i+1}. ${x.description.slice(0,80)} — ${x.quantity} ${x.unit} × ${x.unitPrice} = ${money(BigInt(x.cents))}`).join('\n');
            await ctx.reply(`Проверьте черновик ${d.number} от ${d.date}\nПродавец: ${d.seller}\nПокупатель: ${d.buyer}\nВалюта: ${d.currency}\n\n${rows}${d.items.length>10 ? `\n... и ещё ${d.items.length-10} позиций` : ''}\n\nИтого: ${money(BigInt(d.totalCents))} ${d.currency}\n\nСохранить и получить Excel: /save\nОтменить: /cancel`); break;
          }
          case 'confirm': await ctx.reply('Для сохранения используйте /save, для отмены /cancel.'); break;
          case 'saving': await ctx.reply('Черновик сохраняется.'); break;
        }
      } catch {
        await ctx.reply('Не удалось прочитать данные. Проверьте формат текущего шага и отправьте ещё раз; отмена — /cancel.');
      }
    });
  }
  bot.hears(HOME.sections, ctx => ctx.reply(scopeText(kind, ctx.state.roles as Role[])));
  const access = (id: number, roles: Role[]) => `Telegram ID: ${id}\nРоли: ${roles.join(', ')}\nБот: ${name}`;
  bot.command('me', ctx => ctx.reply(access(ctx.from!.id, ctx.state.roles as Role[])));
  bot.hears(HOME.access, ctx => ctx.reply(access(ctx.from!.id, ctx.state.roles as Role[])));
  const help = `${name}\n/menu — меню\n/me — мой доступ\n${kind === 'invoice' ? '/invoice — ручной черновик\n/company — реквизиты покупателя\n/price КОД — поиск в сетке\n/save — сохранить черновик\n/cancel — отмена ввода\n' : ''}\nРабота только в личном чате. Для изменения прав обратитесь к руководителю.\nОбработка файлов, расчёт платежей и выпуск документов ещё не подключены.`;
  bot.command('help', ctx => ctx.reply(help));
  bot.hears(HOME.help, ctx => ctx.reply(help));
  bot.on('callback_query', async ctx => {
    let cleared = false;
    try {
      if (ctx.callbackQuery.message) { await ctx.editMessageReplyMarkup({reply_markup:{inline_keyboard:[]}}); cleared = true; }
    } catch { /* Telegram may no longer permit editing this historical message. */ }
    await ctx.answerCallbackQuery({ text: cleared ? 'Старые кнопки убраны. Откройте /menu.' : 'Старая кнопка недействительна. Откройте /menu.', show_alert: true });
  });
  bot.on('message', ctx => ctx.reply('Откройте /menu. Обработка файлов и документов ещё не подключена.'));
  return bot;
}
