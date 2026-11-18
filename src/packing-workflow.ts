import { InputFile, type Bot, type Context } from 'grammy';
import { canPrepareInvoice, type Role } from './access.js';
import { HOME } from './menu.js';
import { dateField, valueField, CURRENCIES } from './invoice-draft.js';
import type { CompanyProfile } from './company-profile.js';
import { parsePackingXlsx, MAX_UPLOAD_BYTES } from './packing-xlsx.js';
import { analyseRows, anthropicSuggest, type Suggest } from './packing-ai.js';
import { createInvoiceWork, editItem, issues, reviewWorkbook, invoiceWorkbook, type InvoiceWork, type PackingJobs } from './packing-invoice.js';

type Ctx = Context & { state: { roles: Role[] } };
type Session = { stage:'upload'|'processing'|'review'|'busy'; buyer:CompanyProfile; work?:InvoiceWork };
export function registerPackingWorkflow(bot:Bot<Ctx>, token:string, jobs:PackingJobs | undefined, loadBuyer:()=>Promise<CompanyProfile>, suggest:Suggest=anthropicSuggest(process.env.ANTHROPIC_API_KEY ?? '')) {
  const sessions=new Map<number,Session>();
  const begin=async(ctx:Ctx)=>{
    if(!canPrepareInvoice(ctx.state.roles)){await ctx.reply('Нет доступа к созданию инвойса.');return;}
    if(!jobs){await ctx.reply('Хранилище инвойсов не настроено.');return;}
    try {const buyer=await loadBuyer();sessions.set(ctx.from!.id,{stage:'upload',buyer});await ctx.reply(`Покупатель / получатель: ${buyer.name}.\nОтправьте packing в формате XLSX (до 20 МБ). Данные будут обработаны ИИ; результат нужно проверить.\nОтмена: /cancel`);} catch {await ctx.reply('Не удалось загрузить реквизиты ПТК.');}
  };
  bot.hears(HOME.newInvoice,begin);bot.command(['new','invoice'],begin);
  bot.command('cancel',async ctx=>{sessions.delete(ctx.from!.id);await ctx.reply('Текущий ввод отменён.');});
  bot.command('resume',async ctx=>{if(!canPrepareInvoice(ctx.state.roles)||!jobs){await ctx.reply('Нет доступа.');return;}try{const work=await jobs.latest(ctx.from!.id);if(!work){await ctx.reply('Нет сохранённой партии для проверки.');return;}sessions.set(ctx.from!.id,{stage:'review',buyer:work.buyer,work});await ctx.reply('Последняя партия восстановлена. Отправьте /review.');}catch{await ctx.reply('Не удалось восстановить партию.');}});
  bot.on('message:document',async ctx=>{
    const id=ctx.from.id,s=sessions.get(id);
    if(!canPrepareInvoice(ctx.state.roles)){await ctx.reply('Нет доступа к созданию инвойса.');return;}
    if(!s || s.stage!=='upload'){await ctx.reply('Нажмите «📥 Новый инвойс», затем отправьте packing XLSX.');return;}
    const doc=ctx.message.document;
    if(!doc.file_name?.toLowerCase().endsWith('.xlsx') || (doc.file_size ?? 0)>MAX_UPLOAD_BYTES){await ctx.reply('Нужен файл XLSX размером до 20 МБ.');return;}
    s.stage='processing';await ctx.reply('Получил packing. Обрабатываю файл и готовлю таблицу для проверки.');
    void (async()=>{try {
      const file=await ctx.api.getFile(doc.file_id);const path=file.file_path;
      if(!path || path.split('/').some(x=>x==='..' || x==='.' || !x))throw new Error('Не удалось получить файл из Telegram.');
      const res=await fetch(`https://api.telegram.org/file/bot${token}/${path.split('/').map(encodeURIComponent).join('/')}`,{signal:AbortSignal.timeout(60_000)});
      if(!res.ok || !res.body)throw new Error('Не удалось скачать файл из Telegram.');
      const parts:Buffer[]=[];let length=0;
      for await(const part of res.body as unknown as AsyncIterable<Uint8Array>){length+=part.length;if(length>MAX_UPLOAD_BYTES)throw new Error('Файл больше 20 МБ.');parts.push(Buffer.from(part));}
      const source=Buffer.concat(parts),rows=await parsePackingXlsx(source), suggestions=await analyseRows(rows,suggest);
      if(sessions.get(id)!==s)return;
      const work=createInvoiceWork(id,doc.file_name!,s.buyer,rows,suggestions);
      const review=await reviewWorkbook(work);await jobs!.create(work,source);
      if(sessions.get(id)!==s)return;
      s.work=work;s.stage='review';
      await ctx.replyWithDocument(new InputFile(review,'packing-check.xlsx'),{caption:`Найдено позиций: ${work.items.length}. Проверьте все строки, коды и лист «Прочие строки». Коды предложены ИИ и требуют проверки специалиста.\n\nДля реквизитов и исправлений отправьте /review.`});
      await ctx.reply('Далее укажите номер, дату, продавца с адресом, условия и валюту. Команды: /review.');
    }catch(error){if(sessions.get(id)===s){s.stage='upload';const msg=error instanceof Error && !/telegram|fetch|http/i.test(error.message)?error.message:'Ошибка связи с сервисом.';await ctx.reply(`Не удалось обработать packing: ${msg.slice(0,250)}\nОтправьте файл ещё раз или /cancel.`);}}})();
  });
  const get=(ctx:Ctx):Session|undefined=>{const s=sessions.get(ctx.from!.id);return canPrepareInvoice(ctx.state.roles)&&s?.stage==='review'&&s.work?s:undefined;};
  const instructions='Проверьте файл и лист «Прочие строки». Для каждой позиции проверьте код, количество, единицу и сумму.\n\n/number НОМЕР\n/date 2026-11-18\n/seller НАЗВАНИЕ И АДРЕС\n/terms УСЛОВИЯ ПОСТАВКИ И ОПЛАТЫ\n/currency USD\n/set НОМЕР ПОЛЕ ЗНАЧЕНИЕ\nПоля: name, code, qty, unit, net, gross, amount.\nПример: /set 1 code 1234567890\n\nПосле проверки: /approve. Отмена: /cancel. Восстановить последнюю партию: /resume.';
  bot.command('review',async ctx=>{const s=get(ctx);if(!s){await ctx.reply('Нет открытой партии для проверки.');return;}const missing=issues(s.work!);await ctx.replyWithDocument(new InputFile(await reviewWorkbook(s.work!),'packing-check.xlsx'),{caption:`Проверка: позиций ${s.work!.items.length}. ${missing.length?`Не заполнено или требует исправления: ${missing.length}.`:'Обязательные поля заполнены.'}`});await ctx.reply(instructions+(missing.length?'\n\n'+missing.slice(0,20).join('\n'):''));});
  for(const command of ['number','date','seller','terms','currency','set'] as const) bot.command(command,async ctx=>{
    const s=get(ctx);if(!s){await ctx.reply('Сначала загрузите packing через «Новый инвойс».');return;}
    const next=structuredClone(s.work!);const arg=String(ctx.match).trim();
    try {
      if(command==='set'){const m=arg.match(/^(\d+)\s+(name|code|qty|unit|net|gross|amount)\s+(.+)$/s);if(!m)throw new Error('Формат: /set 1 code 1234567890');editItem(next,Number(m[1]),m[2]!,m[3]!);}
      else if(command==='number')next.invoiceNumber=valueField(arg,80);
      else if(command==='date')next.invoiceDate=dateField(arg);
      else if(command==='seller')next.seller=valueField(arg,500);
      else if(command==='terms')next.terms=valueField(arg,500);
      else {const currency=arg.toUpperCase();if(!CURRENCIES.includes(currency as typeof CURRENCIES[number]))throw new Error('Валюта: USD, EUR, RUB, KZT или CNY.');next.currency=currency;}
      s.stage='busy';await jobs!.update(next,'REVIEW');s.work=next;s.stage='review';await ctx.reply('Сохранено. Для проверки отправьте /review.');
    }catch(e){s.stage='review';await ctx.reply(e instanceof Error && e.message.length>3 ? e.message.slice(0,200) : 'Проверьте формат команды.');}
  });
  bot.command('approve',async ctx=>{const s=get(ctx);if(!s){await ctx.reply('Нет партии для выпуска.');return;}const work=s.work!,missing=issues(work);if(missing.length){await ctx.reply(`Нужно заполнить и исправить:\n${missing.slice(0,30).join('\n')}\n\nКоманды: /review`);return;}s.stage='busy';try{const output=await invoiceWorkbook(work);await ctx.replyWithDocument(new InputFile(output,'invoice.xlsx'),{caption:'Инвойс сформирован по проверенным данным. Проверьте документ и реквизиты перед использованием.'});await jobs!.update(work,'APPROVED');sessions.delete(ctx.from!.id);}catch{s.stage='review';await ctx.reply('Не удалось отправить или сохранить инвойс. Повторите /approve.');}});
}
