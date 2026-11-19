import ExcelJS from 'exceljs';
import {spawn} from 'node:child_process';
import {resolve} from 'node:path';
import type {CommercialInvoice,Company} from './commercial-types.js';
import type {CompanyProfile} from './company-profile.js';
import type {InvoiceWork} from './packing-invoice.js';
import {lineAmount,cents,scaled} from './commercial-math.js';
import {money} from './invoice-draft.js';
import {specificationWorkbook} from './specification.js';

function profile(c:Company):CompanyProfile {return{name:c.name,fields:[['Страна',c.country],['Адрес',c.address],['ИНН / регистрационный номер',c.taxId],['Банк',c.bank],['Счёт',c.account],['SWIFT / BIC',c.swift],['Контакт',c.contact],['Дополнительно',c.extra]].filter(([,v])=>!!v).map(([label,value])=>({label:label!,value:value!}))};}
export function commercialIssues(w:CommercialInvoice):string[] {
 const errors:string[]=[];
 if(w.packingPending)errors.push('обработка последнего загруженного packing');
 if(!w.seller?.name||!w.seller.address)errors.push('продавец и его адрес');
 if(!w.shipper?.name||!w.shipper.address)errors.push('отправитель и его адрес');
 if(!w.buyer?.name||!w.buyer.address)errors.push('покупатель и его адрес');
 if(!w.consignee?.name||!w.consignee.address)errors.push('грузополучатель и его адрес');
 if(!w.number)errors.push('номер инвойса');if(!w.date)errors.push('дата инвойса');
 if(process.env.INVOICE_TEMPLATE_PATH){if(!w.contractNumber)errors.push('номер контракта');if(!w.contractDate)errors.push('дата контракта');if(!w.paymentTerms)errors.push('условия оплаты');}
 if(!['USD','EUR','RUB','KZT','CNY'].includes(w.currency))errors.push('валюта');
 if(w.omitted.some(x=>x.reason.startsWith('Строка похожа'))&&!w.sourceRowsConfirmed)errors.push('проверка пропущенных строк исходного packing');if(!w.items.length)errors.push('товарные позиции');if(!w.priceMethod)errors.push('подтверждённый способ расчёта');if(w.target&&w.priceMethod==='manual')try{if(w.items.reduce((a,x)=>a+cents(x.amount),0n)!==cents(w.target))errors.push('сумма не совпадает с заданной общей стоимостью');}catch{errors.push('сумма по товарам');}
 for(const [i,x] of w.items.entries()){
  const e:string[]=[];if(!x.name)e.push('наименование');if(!x.quantity||!x.unit)e.push('количество и единица');else try{if(scaled(x.quantity)===0n)e.push('количество больше нуля');}catch{e.push('корректное количество');}
  if(x.code&&!/^\d{10}$/.test(x.code))e.push('некорректный код ТН ВЭД');else if(x.code&&!x.codeConfirmed)e.push('подтверждение кода ТН ВЭД');else if(!x.code&&!w.allowBlankCodes)e.push('код ТН ВЭД или подтверждение выпуска без него');
  if(!x.unitPrice||!x.amount)e.push('цена и сумма');
  else try{if(cents(lineAmount(x.quantity,x.unitPrice))!==cents(x.amount))e.push('цена × количество не совпадает с суммой');}catch{e.push('некорректные числа');}
  try{if(x.net&&x.gross&&scaled(x.net)>scaled(x.gross))e.push('нетто больше брутто');}catch{e.push('некорректный вес');}
  if(e.length)errors.push(`позиция ${i+1}: ${e.join(', ')}`);
 }
 return errors;
}
export async function commercialWorkbook(w:CommercialInvoice,final=false):Promise<Buffer>{
 if(final&&commercialIssues(w).length)throw new Error('Заполните обязательные поля.');
 if(process.env.INVOICE_TEMPLATE_PATH)return templateBundle(w,final,process.env.INVOICE_TEMPLATE_PATH);
 const blank:CompanyProfile={name:'[УКАЗАТЬ]',fields:[]};
 const legacy:InvoiceWork={id:w.id,owner:w.owner,filename:w.filename,buyer:w.buyer?profile(w.buyer):blank,consigneeDetails:w.consignee?profile(w.consignee):undefined,sellerDetails:w.seller?profile(w.seller):undefined,shipperDetails:w.shipper?profile(w.shipper):undefined,payerDetails:w.payer?profile(w.payer):undefined,items:w.items,omitted:w.omitted,invoiceNumber:w.number,invoiceDate:w.date,seller:w.seller?.name??'',terms:w.terms,currency:w.currency};
 const data=await specificationWorkbook(legacy,final),book=new ExcelJS.Workbook();await book.xlsx.load(data as never);const sheet=book.addWorksheet('Invoice');sheet.views=[{state:'frozen',ySplit:18}];sheet.columns=[{width:6},{width:48},{width:16},{width:13},{width:10},{width:12},{width:14},{width:14},{width:17},{width:19}];
 sheet.mergeCells('A1:J1');sheet.getCell('A1').value=final?'COMMERCIAL INVOICE / КОММЕРЧЕСКИЙ ИНВОЙС':'COMMERCIAL INVOICE / ПРЕДПРОСМОТР';sheet.getCell('A1').font={bold:true,size:16};sheet.getCell('A3').value='Invoice No.';sheet.getCell('B3').value=w.number||null;sheet.getCell('E3').value='Date';sheet.getCell('F3').value=w.date||null;sheet.getCell('H3').value='Currency';sheet.getCell('I3').value=w.currency||null;
 const details=(c:Company|undefined)=>c?[c.name,c.country,c.address,c.taxId&&`Рег. № / Tax ID: ${c.taxId}`,c.bank&&`Bank: ${c.bank}`,c.account&&`Account: ${c.account}`,c.swift&&`SWIFT/BIC: ${c.swift}`,c.contact&&`Contact: ${c.contact}`,c.extra].filter(Boolean).join('\n'):'';
 for(const [labelRow,label,company] of [[5,'SELLER / ПРОДАВЕЦ',w.seller],[8,'SHIPPER / ОТПРАВИТЕЛЬ',w.shipper],[11,'BUYER / ПОКУПАТЕЛЬ',w.buyer],[14,'CONSIGNEE / ПОЛУЧАТЕЛЬ',w.consignee]] as const){sheet.mergeCells(`A${labelRow}:J${labelRow}`);sheet.getCell(`A${labelRow}`).value=label;sheet.getCell(`A${labelRow}`).font={bold:true};sheet.mergeCells(`A${labelRow+1}:J${labelRow+2}`);const cell=sheet.getCell(`A${labelRow+1}`);const text=details(company);cell.value=text||null;cell.alignment={wrapText:true,vertical:'top'};const height=Math.min(200,Math.max(42,Math.ceil((text.split('\n').reduce((n,line)=>n+Math.max(1,Math.ceil(line.length/110)),0)*14+8)/2)));sheet.getRow(labelRow+1).height=height;sheet.getRow(labelRow+2).height=height;}
 sheet.mergeCells('A17:J17');sheet.getCell('A17').value=w.terms?`Delivery terms / Условия поставки: ${w.terms}`:'Delivery terms / Условия поставки:';const header=['№','DESCRIPTION / НАИМЕНОВАНИЕ','HS CODE','QUANTITY','UNIT','PACKAGES','NET KG','GROSS KG','UNIT PRICE','AMOUNT'];sheet.getRow(18).values=header;sheet.getRow(18).font={bold:true};sheet.getRow(18).alignment={wrapText:true,vertical:'middle'};sheet.getRow(18).height=30;
 const numberOrNull=(value:string|undefined)=>value&&/^(?:\d+)(?:\.\d+)?$/.test(value)?Number(value):null;for(const [i,item] of w.items.entries()){const row=sheet.addRow([i+1,item.name,item.code||null,numberOrNull(item.quantity),item.unit||null,numberOrNull(item.packages),numberOrNull(item.net),numberOrNull(item.gross),numberOrNull(item.unitPrice),numberOrNull(item.amount)]);row.height=38;row.alignment={wrapText:true,vertical:'top'};row.getCell(9).numFmt='0.##########';row.getCell(10).numFmt='#,##0.00';}
 const total=sheet.addRow(['','TOTAL / ИТОГО','','','','','','','',w.items.every(x=>!!x.amount)?Number(money(w.items.reduce((n,x)=>n+cents(x.amount),0n))):null]);total.font={bold:true};total.getCell(10).numFmt='#,##0.00';if(w.payer){sheet.addRow(['PAYER / ПЛАТЕЛЬЩИК',details(w.payer)]);sheet.getRow(sheet.rowCount).alignment={wrapText:true};}sheet.pageSetup={orientation:'landscape',fitToPage:true,fitToWidth:1,fitToHeight:0};return Buffer.from(await book.xlsx.writeBuffer());
}

export async function templateBundle(w:CommercialInvoice,final:boolean,template:string):Promise<Buffer>{
 return new Promise((resolveBundle,reject)=>{
  const child=spawn(process.env.INVOICE_PYTHON_PATH||'python3',[resolve('scripts/build_invoice_bundle.py')],{env:{PATH:process.env.PATH||'/usr/bin:/bin',HOME:process.env.HOME||'',LANG:'en_US.UTF-8',PYTHONIOENCODING:'utf-8',INVOICE_TEMPLATE_PATH:template},stdio:['pipe','pipe','pipe']});
  const chunks:Buffer[]=[];let size=0,finished=false;const fail=()=>{if(!finished){finished=true;clearTimeout(timer);child.kill();reject(new Error('Не удалось сформировать комплект по шаблону. Проверьте файл шаблона и данные.'));}};
  const timer=setTimeout(fail,90000);child.on('error',fail);child.stdin.on('error',fail);child.stdout.on('error',fail);child.stderr.on('error',fail);child.stderr.resume();
  child.stdout.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size>32*1024*1024){fail();return;}chunks.push(chunk);});
  child.on('close',code=>{if(finished)return;if(code!==0||!size){fail();return;}finished=true;clearTimeout(timer);resolveBundle(Buffer.concat(chunks));});
  child.stdin.end(JSON.stringify({work:w,final}));
 });
}
