import test from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import type { Update, UserFromGetMe } from 'grammy/types';
import { createBot } from '../src/bot.js';
import { HOME } from '../src/menu.js';
import type { InvoiceWork, PackingJobs } from '../src/packing-invoice.js';
const info={id:123,is_bot:true,first_name:'Test',username:'test_bot',can_join_groups:false,can_read_all_group_messages:false,supports_inline_queries:false,can_connect_to_business:false,has_main_web_app:false,has_topics_enabled:false,allows_users_to_create_topics:false,can_manage_bots:false,supports_join_request_queries:false} as UserFromGetMe;
function msg(text:string):Update{return{update_id:1,message:{message_id:1,date:0,from:{id:42,is_bot:false,first_name:'Test'},chat:{id:42,type:'private',first_name:'Test'},text,...(text.startsWith('/')?{entities:[{type:'bot_command' as const,offset:0,length:text.split(' ')[0]!.length}]}:{})}};}
function cb(data:string):Update{return{update_id:2,callback_query:{id:'q',from:{id:42,is_bot:false,first_name:'Test'},chat_instance:'x',message:(msg('x') as {message:NonNullable<Update['message']>}).message,data}};}

test('owner uploads a standard packing, reviews, edits with buttons and downloads template',async()=>{
 const book=new ExcelJS.Workbook(),sheet=book.addWorksheet('Packing');sheet.addRow(['№','Description','Weight netto (kg)','Gross weight (kg)','Quantity','PRICE PER 100','','Amount, USD','Package']);sheet.addRow(['','','','','','USD','pcs, set']);sheet.addRow([1,'Тест',1,2,100,250,'pcs',250,1]);
 const binary=Buffer.from(await book.xlsx.writeBuffer());let saved:InvoiceWork|undefined;
 const jobs:PackingJobs={async create(w){saved=w;},async update(w){saved=w;},async latest(){return saved??null;},async approve(){throw Error('should not approve incomplete');},async list(){return[];},async get(){return null;}};
 const bot=createBot('123:test','invoice',{async rolesFor(){return[];}},[42],'',undefined,async()=>({name:'Тест',fields:[{label:'ИНН',value:'123'}]}),jobs);bot.botInfo=info;
 const calls:{method:string;payload:Record<string,unknown>}[]=[];bot.api.config.use(async(_p,method,payload)=>{calls.push({method,payload:payload as unknown as Record<string,unknown>});if(method==='getFile')return {ok:true,result:{file_id:'f',file_unique_id:'f',file_path:'documents/test.xlsx'}} as never;return {ok:true,result:true} as never;});
 const originalFetch=globalThis.fetch;globalThis.fetch=async()=>new Response(binary);
 try{
  await bot.handleUpdate(msg(HOME.newInvoice));assert.match(String(calls.at(-1)!.payload.text),/Прикрепите packing/);
  const file=msg('') as {update_id:number;message:NonNullable<Update['message']>};delete (file.message as {text?:string}).text;Object.assign(file.message,{document:{file_id:'f',file_unique_id:'f',file_name:'test.xlsx'}});await bot.handleUpdate(file);
  for(let i=0;i<100&&!saved;i++)await new Promise(r=>setTimeout(r,10));assert.ok(saved);assert.equal(saved.items[0]!.unitPrice,'2.5000');
  const id=saved.id.slice(0,8);for(let i=0;i<100&&!calls.some(c=>String(c.payload.text).includes('Партия:'));i++)await new Promise(r=>setTimeout(r,10));const panel=calls.find(c=>String(c.payload.text).includes('Партия:'))!;assert.ok((panel.payload.reply_markup as {keyboard?:unknown}).keyboard);assert.doesNotMatch(String(panel.payload.text),/\/number|\/seller/);await bot.handleUpdate(msg('📋 Товары'));assert.match(String(calls.at(-1)!.payload.text),/Тест/);
  await bot.handleUpdate(cb(`v:${id}:edit:code`));await bot.handleUpdate(msg('1234567890'));assert.equal(saved.items[0]!.code,'1234567890');
  await bot.handleUpdate(cb(`v:${id}:wizard:0`));assert.match(String(calls.at(-1)!.payload.text),/Шаг 1 из/);await bot.handleUpdate(msg('TEST-1'));assert.equal(saved.invoiceNumber,'TEST-1');assert.match(String(calls.at(-1)!.payload.text),/Шаг 2 из/);await bot.handleUpdate(cb(`v:${id}:wizard:2`));assert.match(String(calls.at(-1)!.payload.text),/Шаг 3 из/);
  await bot.handleUpdate(cb(`v:${id}:preview`));assert.equal(calls.at(-1)!.method,'sendDocument');
  await bot.handleUpdate(msg('✅ Сформировать инвойс'));assert.match(String(calls.at(-1)!.payload.text),/Перед выпуском/);assert.doesNotMatch(String(calls.at(-1)!.payload.text),/\/number|позиция 1:/);
 }finally{globalThis.fetch=originalFetch;}
});
