import type {CommercialInvoice} from './commercial-types.js';
import {allocate,amountByWeight,cents,lineAmount,priceForAmount,scaled} from './commercial-math.js';
import {money,valueField} from './invoice-draft.js';

function copy(w:CommercialInvoice):CommercialInvoice{return structuredClone(w);}
export function sourcePrices(work:CommercialInvoice):CommercialInvoice {
 const w=copy(work);for(const [i,x] of w.items.entries()){
  if(!x.quantity||!x.unitPrice)throw new Error(`Позиция ${i+1}: нет количества или цены за единицу.`);
  const value=lineAmount(x.quantity,x.unitPrice);if(x.amount&&cents(x.amount)!==cents(value))throw new Error(`Позиция ${i+1}: цена и сумма отличаются. Проверьте источник.`);x.amount=value;x.priceMismatch=false;
 }
 w.priceMethod='source';return w;
}
export function distribute(work:CommercialInvoice,total:string,basis:'value'|'net'|'gross'):CommercialInvoice {
 const w=copy(work);const weights=w.items.map((x,i)=>{const n=basis==='value'?(x.sourceAmount??x.amount):basis==='net'?x.net:x.gross;if(!n)throw new Error(`Позиция ${i+1}: отсутствует ${basis==='value'?'исходная сумма':'вес'}.`);return n;});
 if(cents(total)<=0n)throw new Error('Сумма должна быть больше нуля.');const amounts=allocate(total,weights);
 w.items.forEach((x,i)=>{x.unitPrice=priceForAmount(x.quantity,amounts[i]!);x.amount=amounts[i]!;x.priceMismatch=false;});
 w.priceMethod='total';w.target=money(cents(total));w.distribution=basis;return w;
}
export function priceByWeight(work:CommercialInvoice,rate:string,basis:'net'|'gross'):CommercialInvoice {
 const weights=work.items.map((x,i)=>{const n=basis==='net'?x.net:x.gross;if(!n)throw new Error(`Позиция ${i+1}: отсутствует вес ${basis==='net'?'нетто':'брутто'}.`);return n;});
 const total=amountByWeight(rate,weights),w=distribute(work,total,basis);w.priceMethod='kg';w.rate=rate;w.rateBasis=basis;return w;
}
export function editCommercialItem(work:CommercialInvoice,index:number,field:string,input:string):CommercialInvoice {
 const w=copy(work),x=w.items[index];if(!x)throw new Error('Позиция не найдена.');const v=valueField(input,300);
 switch(field){
  case 'name':x.name=v;if(x.code)x.codeConfirmed=false;break;
  case 'code':if(!/^\d{10}$/.test(v))throw new Error('Код должен содержать 10 цифр.');x.code=v;x.codeConfirmed=false;break;
  case 'qty':if(!scaled(v))throw new Error('Количество должно быть больше нуля.');x.quantity=v.replace(',','.');if(x.unitPrice)x.amount=lineAmount(x.quantity,x.unitPrice);break;
  case 'price':scaled(v);x.unitPrice=v.replace(',','.');x.amount=lineAmount(x.quantity,x.unitPrice);break;
  case 'unit':x.unit=v;break;
  case 'net':case 'gross':scaled(v);x[field]=v.replace(',','.');if(x.net&&x.gross&&scaled(x.net)>scaled(x.gross))throw new Error('Нетто не может превышать брутто.');break;
  case 'packages':if(!/^\d+$/.test(v))throw new Error('Количество мест должно быть целым числом.');x.packages=v;break;
  default:throw new Error('Поле недоступно.');
 }
 if(field==='qty'||field==='price'){x.priceMismatch=false;w.priceMethod='manual';w.rate=undefined;}
 return w;
}
export function commercialTotal(work:CommercialInvoice):string {return money(work.items.reduce((a,x)=>a+(x.amount?cents(x.amount):0n),0n));}
