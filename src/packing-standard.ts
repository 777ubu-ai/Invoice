import type { PackingRow } from './packing-xlsx.js';
import { createInvoiceWork, type InvoiceWork } from './packing-invoice.js';
import type { CompanyProfile } from './company-profile.js';
import type { SuggestedRow } from './packing-ai.js';
import { parseItems } from './invoice-draft.js';

// Recognise the supplied two-row packing format only when all required headers agree.
// Unknown layouts are handled separately, never interpreted by column position alone.
export function standardPacking(owner:number,filename:string,buyer:CompanyProfile,rows:PackingRow[]):InvoiceWork|null {
  const header=rows.find(r=>{
    const a=r.cells.map(x=>x.trim().toLowerCase());
    return a[0]==='№' && a[1]==='description' && /netto/.test(a[2]??'') && /gross/.test(a[3]??'') && a[4]==='quantity' && /price\s+per\s+100/i.test(a[5]??'') && /amount.*usd/i.test(a[7]??'') && /package/i.test(a[8]??'');
  });
  if(!header)return null;
  const positions=rows.filter(r=>r.sheet===header.sheet && r.row>header.row && /^\d+$/.test(r.cells[0]??'') && !!r.cells[1]);
  if(!positions.length)return null;
  const invalid=rows.some(r=>r.sheet===header.sheet && r.row>header.row && /^\d+$/.test(r.cells[0]??'') && !r.cells[1]);
  if(invalid)throw new Error('В packing есть строка с номером, но без наименования. Исправьте файл.');
  const suggestions:SuggestedRow[]=rows.map(r=>({sourceId:r.id,kind:positions.includes(r)?'item':'other',nameColumn:positions.includes(r)?1:null,quantityColumn:positions.includes(r)?4:null,unitColumn:positions.includes(r)?6:null,netColumn:positions.includes(r)?2:null,grossColumn:positions.includes(r)?3:null,amountColumn:positions.includes(r)?7:null,nameRu:positions.includes(r)?r.cells[1]!: '',suggestedCode:'',reason:r.sheet===header.sheet&&r.row>header.row&&!!r.cells[1]&&/^\d+(?:[.,]\d+)?$/.test((r.cells[4]??'').trim())&&!positions.includes(r)?'Строка похожа на товар — проверьте':'Заголовок, итог или прочая строка'}));
  const work=createInvoiceWork(owner,filename,buyer,rows,suggestions);work.currency='USD';
  for(const [i,r] of positions.entries()) {
    const item=work.items[i]!;item.packages=r.cells[8]??'';
    const price=(r.cells[5]??'').trim().replace(',','.');
    if(/^\d{1,12}(?:\.\d{1,2})?$/.test(price)) {
      const [whole,fraction='']=price.split('.');const n=BigInt(whole!)*100n+BigInt(fraction.padEnd(2,'0'));
      item.unitPrice=`${n/10000n}.${String(n%10000n).padStart(4,'0')}`;
      try {item.priceMismatch=BigInt(parseItems(`x|${item.quantity}|unit|${item.unitPrice}`)[0]!.cents)!==BigInt(parseItems(`x|1|unit|${item.amount}`)[0]!.cents);}catch{item.priceMismatch=true;}
    }
  }
  const total=rows.find(r=>r.sheet===header.sheet && r.row>header.row && /^(total|итого)$/i.test((r.cells[0]??'').trim()));
  work.warnings=[];
  if(total){for(const [column,label] of [[2,'нетто'],[3,'брутто'],[4,'количество'],[7,'сумма'],[8,'места']] as const){const given=(total.cells[column]??'').trim();if(!given)continue;const toN=(x:string)=>{const [a,b='']=x.replace(',','.').split('.');if(!/^\d+$/.test(a??'')||!/^\d{0,6}$/.test(b))return null;return BigInt(a!)*1000000n+BigInt((b+'000000').slice(0,6));};const expected=toN(given);let actual=0n,valid=true;for(const row of positions){const v=toN(row.cells[column]??'');if(v===null){valid=false;break;}actual+=v;}if(expected!==null&&valid&&expected!==actual)work.warnings.push(`Итог источника: ${label} не совпадает с суммой позиций.`);}}
  if(work.items.some(x=>x.packages==='0'))work.warnings.push('Есть позиция с нулём грузовых мест: проверьте данные packing.');
  return work;
}
