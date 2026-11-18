import type {CommercialInvoice,Company} from './commercial-types.js';
import type {CompanyProfile} from './company-profile.js';
import type {InvoiceWork} from './packing-invoice.js';
import {lineAmount,cents,scaled} from './commercial-math.js';
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
 const blank:CompanyProfile={name:'[УКАЗАТЬ]',fields:[]};
 const legacy:InvoiceWork={id:w.id,owner:w.owner,filename:w.filename,buyer:w.buyer?profile(w.buyer):blank,consigneeDetails:w.consignee?profile(w.consignee):undefined,sellerDetails:w.seller?profile(w.seller):undefined,shipperDetails:w.shipper?profile(w.shipper):undefined,payerDetails:w.payer?profile(w.payer):undefined,items:w.items,omitted:w.omitted,invoiceNumber:w.number,invoiceDate:w.date,seller:w.seller?.name??'',terms:w.terms,currency:w.currency};
 return specificationWorkbook(legacy,final);
}
