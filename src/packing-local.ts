import type {PackingRow} from './packing-xlsx.js';
import type {CompanyProfile} from './company-profile.js';
import type {SuggestedRow} from './packing-ai.js';
import {createInvoiceWork,type InvoiceWork} from './packing-invoice.js';
import {lineAmount} from './commercial-math.js';
import {standardPacking} from './packing-standard.js';

const norm=(s:string)=>s.toLowerCase().replace(/[\s_\-]+/g,' ').trim();
// Only unambiguous, labelled Excel columns are accepted. The remaining rows are retained for review.
export function parsePackingLocally(owner:number,filename:string,buyer:CompanyProfile,rows:PackingRow[]):InvoiceWork {
 const exact=standardPacking(owner,filename,buyer,rows);if(exact)return exact;
 for(const h of rows){
  const lower=h.cells.map(norm);
  const find=(re:RegExp)=>{const a=lower.flatMap((x,i)=>re.test(x)?[i]:[]);return a.length===1?a[0]!:null;};
  const name=find(/^(наименование(?: товара)?|товар|описание(?: товара)?|description|product(?: name)?|goods)$/);
  const qty=find(/^(кол-?во|количество(?: товара)?|qty|quantity)$/);
  if(name===null||qty===null||name===qty)continue;
  const unit=find(/^(ед\.?\s*изм\.?|единица(?: измерения)?|unit|units|pcs,?\s*set)$/);
  const net=find(/^(вес нетто(?: кг)?|нетто(?: кг)?|net(?:to)? weight(?: \(?kg\)?)?|weight netto \(?kg\)?)$/);
  const gross=find(/^(вес брутто(?: кг)?|брутто(?: кг)?|gross weight(?: \(?kg\)?)?|weight gross \(?kg\)?)$/);
  const amount=find(/^(сумма|стоимость(?: товара)?|total amount(?:,?\s*(usd|eur|rub|cny|kzt))?|amount(?:,?\s*(usd|eur|rub|cny|kzt))?)$/);
  const price=find(/^(цена(?: за единицу)?|unit price(?:,?\s*(usd|eur|rub|cny|kzt))?|price(?:,?\s*(usd|eur|rub|cny|kzt))?)$/);
  const packages=find(/^(места|количество мест|грузовые места|packages?|cartons?)$/);
  const possible=rows.filter(r=>r.sheet===h.sheet&&r.row>h.row);
  const isTotal=(v:string)=>/^(?:итого|всего|total|sum|合计|总计|小计)$/i.test(v.trim());
  const items=possible.filter(r=>!!r.cells[name]&&!isTotal(r.cells[name]!)&&/^\d+(?:[.,]\d+)?$/.test((r.cells[qty]??'').trim()));
  if(!items.length)continue;
  const malformed=possible.some(r=>!!r.cells[name]&&/^\d/.test((r.cells[qty]??'').trim())&&!/^\d+(?:[.,]\d+)?$/.test((r.cells[qty]??'').trim()));
  if(malformed)throw new Error('В файле есть некорректное количество. Исправьте XLSX и загрузите снова.');
  const suggestions:SuggestedRow[]=rows.map(r=>({sourceId:r.id,kind:items.includes(r)?'item':'other',nameColumn:items.includes(r)?name:null,quantityColumn:items.includes(r)?qty:null,unitColumn:items.includes(r)?unit:null,netColumn:items.includes(r)?net:null,grossColumn:items.includes(r)?gross:null,amountColumn:items.includes(r)?amount:null,nameRu:items.includes(r)?r.cells[name]!: '',suggestedCode:'',reason:r.sheet===h.sheet&&r.row>h.row&&!!r.cells[name]&&!isTotal(r.cells[name]!)&&!items.includes(r)?'Строка похожа на товар — проверьте':'Заголовок, итог или прочая строка'}));
  const work=createInvoiceWork(owner,filename,buyer,rows,suggestions);
  const currencies=new Set((h.cells.join(' ').toUpperCase().match(/\b(?:USD|EUR|RUB|CNY|KZT)\b/g)??[]));if(currencies.size===1)work.currency=[...currencies][0]!;
  for(const [i,r] of items.entries()){
   const item=work.items[i]!;if(packages!==null)item.packages=(r.cells[packages]??'').trim();
   if(price!==null){const p=(r.cells[price]??'').trim().replace(',','.');if(/^\d{1,12}(?:\.\d{1,6})?$/.test(p)){item.unitPrice=p;try{const calculated=lineAmount(item.quantity,p);if(item.amount)item.priceMismatch=calculated!==lineAmount('1',item.amount);else item.amount=calculated;}catch{item.priceMismatch=true;}}}
  }
  work.warnings=['Другой формат XLSX: проверьте сопоставление столбцов и лист «Прочие строки».'];return work;
 }
 throw new Error('Не удалось однозначно найти столбцы наименования и количества. Добавьте заголовки и повторите загрузку.');
}
