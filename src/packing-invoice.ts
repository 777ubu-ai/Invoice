import { randomUUID } from 'node:crypto';
import ExcelJS from 'exceljs';
import type { Pool } from 'pg';
import { money, parseItems, valueField } from './invoice-draft.js';
import type { CompanyProfile } from './company-profile.js';
import type { PackingRow } from './packing-xlsx.js';
import type { SuggestedRow } from './packing-ai.js';
import { specificationWorkbook } from './specification.js';

export type PackingItem = { sourceId:string; sheet:string; sourceRow:number; original:string; name:string; code:string; quantity:string; unit:string; net:string; gross:string; amount:string; packages?:string; unitPrice?:string; priceMismatch?:boolean; brand?:string; maker?:string; origin?:string; packaging?:string };
export type InvoiceWork = { id:string; owner:number; filename:string; buyer:CompanyProfile; items:PackingItem[]; omitted:{sheet:string;row:number;cells:string[];reason:string}[]; invoiceNumber:string; invoiceDate:string; seller:string; terms:string; currency:string; contract?:string; loading?:string; delivery?:string; carrier?:string; driver?:string; vehicle?:string; warnings?:string[]; consigneeDetails?:CompanyProfile; sellerDetails?:CompanyProfile; shipperDetails?:CompanyProfile; payerDetails?:CompanyProfile };

function decimal(value:string):string {
  const x=value.trim().replace(/\s/g,'').replace(',','.');
  if (!/^\d{1,12}(?:\.\d{1,6})?$/.test(x)) return '';
  return x;
}
function sourceValue(row:PackingRow, column:number|null):string { return column === null ? '' : (row.cells[column] ?? '').trim(); }

export function createInvoiceWork(owner:number, filename:string, buyer:CompanyProfile, rows:PackingRow[], suggestions:SuggestedRow[]):InvoiceWork {
  const byId=new Map(rows.map(r=>[r.id,r]));const items:PackingItem[]=[];const omitted:InvoiceWork['omitted']=[];
  for (const s of suggestions) {
    const r=byId.get(s.sourceId);
    if (!r) throw new Error('Строка отсутствует в источнике.');
    if (s.kind==='other') { omitted.push({sheet:r.sheet,row:r.row,cells:r.cells,reason:s.reason}); continue; }
    const original=sourceValue(r,s.nameColumn);
    items.push({sourceId:r.id,sheet:r.sheet,sourceRow:r.row,original,name:s.nameRu || original,code:s.suggestedCode,
      quantity:decimal(sourceValue(r,s.quantityColumn)),unit:sourceValue(r,s.unitColumn).slice(0,30),
      net:decimal(sourceValue(r,s.netColumn)),gross:decimal(sourceValue(r,s.grossColumn)),amount:decimal(sourceValue(r,s.amountColumn))});
  }
  if (!items.length) throw new Error('Не найдено товарных строк. Проверьте файл.');
  return {id:randomUUID(),owner,filename:filename.slice(0,255),buyer,items,omitted,invoiceNumber:'',invoiceDate:'',seller:'',terms:'',currency:''};
}

const FIELDS = ['code','name','qty','unit','net','gross','amount','packages','brand','maker','origin','packaging','price'] as const;
export function editItem(work:InvoiceWork,index:number,field:string,value:string):void {
  const item=work.items[index-1];if(!item || !FIELDS.includes(field as typeof FIELDS[number]))throw new Error('Неверный номер позиции или поле.');
  const clean=valueField(value,300);
  if(field==='code') { if(!/^\d{10}$/.test(clean))throw new Error('Код должен содержать 10 цифр.');item.code=clean;return; }
  if(field==='name') {item.name=clean;return;}
  if(field==='unit') {item.unit=valueField(clean,30);return;}
  if(field==='brand'||field==='maker'||field==='origin'||field==='packaging') {item[field]=clean;return;}
  if(field==='packages') {if(!/^\d+$/.test(clean))throw new Error('Места: целое число не меньше нуля.');item.packages=clean;return;}
  const n=decimal(clean);if(!n || Number(n)<=0)throw new Error('Нужно положительное число.');
  if(field==='qty')item.quantity=n;else if(field==='net')item.net=n;else if(field==='gross')item.gross=n;else if(field==='price')item.unitPrice=n;else item.amount=n;
  if(item.unitPrice && item.quantity && item.amount) {try{item.priceMismatch=BigInt(parseItems(`x|${item.quantity}|unit|${item.unitPrice}`)[0]!.cents)!==BigInt(parseItems(`x|1|unit|${item.amount}`)[0]!.cents);}catch{item.priceMismatch=true;}}
}

export function issues(work:InvoiceWork):string[] {
  const issues:string[]=[];
  if(!work.invoiceNumber)issues.push('номер инвойса');
  if(!work.invoiceDate)issues.push('дата инвойса');
  if(!work.seller)issues.push('продавец и адрес');
  if(!work.contract)issues.push('номер и дата контракта');
  if(!work.terms)issues.push('условия поставки и оплаты');
  if(!['USD','EUR','RUB','KZT','CNY'].includes(work.currency))issues.push('валюта');
  work.items.forEach((item,i)=>{
    const missing:string[]=[];
    if(!item.name)missing.push('наименование');
    if(!/^\d{10}$/.test(item.code))missing.push('код');
    if(!item.quantity || Number(item.quantity)<=0)missing.push('количество');
    if(!item.unit)missing.push('единица');
    if(!item.amount || Number(item.amount)<=0)missing.push('сумма');
    if(!item.net)missing.push('нетто');
    if(!item.gross)missing.push('брутто');
    if(item.packages===undefined || item.packages==='')missing.push('места');
    if(!item.maker)missing.push('производитель');
    if(!item.origin)missing.push('страна происхождения');
    if(!item.packaging)missing.push('вид упаковки');
    if(item.priceMismatch)missing.push('цена и сумма не совпадают');
    if(item.net && item.gross && Number(item.net)>Number(item.gross))missing.push('нетто больше брутто');
    if(missing.length)issues.push(`позиция ${i+1}: ${missing.join(', ')}`);
  });
  return issues;
}

export function applyRate(work:InvoiceWork,rate:string):number {
  const v=decimal(rate);if(!v || Number(v)<=0)throw new Error('Укажите положительную цену за кг.');
  let count=0;
  for(const item of work.items) {
    if (!item.amount && item.net && Number(item.net)>0) {
      item.amount=money(BigInt(parseItems(`x|${item.net}|kg|${v}`)[0]!.cents));count++;
    }
  }
  return count;
}

function itemTotal(items:PackingItem[]):string {
  const cents=items.reduce((sum,it)=>sum+BigInt(parseItems(`x|1|unit|${it.amount}`)[0]!.cents),0n);
  return money(cents);
}
function detailsSheet(book:ExcelJS.Workbook,buyer:CompanyProfile) {
  const sheet=book.addWorksheet('Реквизиты получателя');sheet.columns=[{width:45},{width:95}];
  sheet.addRow(['Покупатель / получатель',buyer.name]);
  for(const f of buyer.fields)sheet.addRow([f.label,f.value]);
  sheet.eachRow(r=>{r.alignment={vertical:'top',wrapText:true};});
}

export async function reviewWorkbook(work:InvoiceWork):Promise<Buffer> {
  const book=new ExcelJS.Workbook();const s=book.addWorksheet('Проверка');
  s.columns=[{width:7},{width:20},{width:10},{width:35},{width:35},{width:18},{width:14},{width:12},{width:15},{width:15},{width:18}];
  s.addRow(['ПРОВЕРКА — коды предложены ИИ, необходимо подтверждение специалиста']);
  s.addRow(['№','Лист','Строка','Наименование исходное','Наименование RU','ТН ВЭД (предложение)','Кол-во','Ед.','Нетто кг','Брутто кг','Сумма по источнику']);
  work.items.forEach((x,i)=>s.addRow([i+1,x.sheet,x.sourceRow,x.original,x.name,x.code,x.quantity,x.unit,x.net,x.gross,x.amount]));
  s.getRow(1).font={bold:true};s.getRow(2).font={bold:true};s.views=[{state:'frozen',ySplit:2}];
  const skipped=book.addWorksheet('Прочие строки');skipped.columns=[{width:25},{width:12},{width:35},{width:110}];
  skipped.addRow(['Лист','Строка','Причина','Исходные ячейки']);
  for(const x of work.omitted)skipped.addRow([x.sheet,x.row,x.reason,x.cells.join(' | ')]);
  detailsSheet(book,work.buyer);
  return Buffer.from(await book.xlsx.writeBuffer());
}

export async function invoiceWorkbook(work:InvoiceWork):Promise<Buffer> {
  if(issues(work).length)throw new Error('Проверьте недостающие данные.');
  return specificationWorkbook(work,true);
}

export type JobRecord={work:InvoiceWork; status:string; source:Buffer; issued:Buffer|null};
export interface PackingJobs { create(work:InvoiceWork,source:Buffer):Promise<void>; update(work:InvoiceWork,status:'REVIEW'|'APPROVED'|'FAILED'|'CANCELED'):Promise<void>; latest(owner:number):Promise<InvoiceWork | null>; approve(work:InvoiceWork,file:Buffer):Promise<void>; list(owner:number,scope:'mine'|'all'|'approved'):Promise<{id:string;filename:string;status:string}[]>; get(id:string,owner:number,scope:'mine'|'all'|'approved'):Promise<JobRecord|null> }
export class PackingJobStore implements PackingJobs {
  constructor(private pool:Pool){}
  async list(owner:number,scope:'mine'|'all'|'approved') {
    const where=scope==='mine'?'created_by=$1':scope==='approved'?"status='APPROVED'":"TRUE";
    const r=await this.pool.query(`SELECT id,filename,status FROM packing_invoice_v2.packing_jobs WHERE ${where} ORDER BY created_at DESC LIMIT 10`,scope==='mine'?[owner]:[]);
    return r.rows as {id:string;filename:string;status:string}[];
  }
  async get(id:string,owner:number,scope:'mine'|'all'|'approved'):Promise<JobRecord|null> {
    const where=scope==='mine'?' AND created_by=$2':scope==='approved'?" AND status='APPROVED'":'';
    const r=await this.pool.query(`SELECT payload,status,source_file,issued_file FROM packing_invoice_v2.packing_jobs WHERE id=$1${where}`,scope==='mine'?[id,owner]:[id]);
    const row=r.rows[0];return row?{work:row.payload as InvoiceWork,status:row.status as string,source:row.source_file as Buffer,issued:row.issued_file as Buffer|null}:null;
  }
  async approve(w:InvoiceWork,file:Buffer) {
    const r=await this.pool.query(`UPDATE packing_invoice_v2.packing_jobs SET payload=$3::jsonb,issued_file=$4,status='APPROVED',updated_at=now() WHERE id=$1 AND created_by=$2 AND status='REVIEW'`,[w.id,w.owner,JSON.stringify(w),file]);
    if(r.rowCount!==1)throw new Error('Запись недоступна или уже завершена.');
  }
  async latest(owner:number) {
    const r=await this.pool.query(`SELECT payload FROM packing_invoice_v2.packing_jobs WHERE created_by=$1 AND status='REVIEW' ORDER BY created_at DESC LIMIT 1`,[owner]);
    return (r.rows[0]?.payload as InvoiceWork | undefined) ?? null;
  }
  async create(w:InvoiceWork,source:Buffer) {
    await this.pool.query(`INSERT INTO packing_invoice_v2.packing_jobs(id,created_by,filename,source_file,buyer_details,payload,status) VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb,'REVIEW')`,[w.id,w.owner,w.filename,source,JSON.stringify(w.buyer),JSON.stringify(w)]);
  }
  async update(w:InvoiceWork,status:'REVIEW'|'APPROVED'|'FAILED'|'CANCELED') {
    const result=await this.pool.query(`UPDATE packing_invoice_v2.packing_jobs SET payload=$3::jsonb,status=$4,updated_at=now() WHERE id=$1 AND created_by=$2 AND status='REVIEW'`,[w.id,w.owner,JSON.stringify(w),status]);
    if(result.rowCount!==1)throw new Error('Запись недоступна или уже завершена.');
  }
}
