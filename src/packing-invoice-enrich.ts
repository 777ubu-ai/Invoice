import type {PackingRow} from './packing-xlsx.js';import type {InvoiceWork} from './packing-invoice.js';import {scaled,lineAmount,cents} from './commercial-math.js';
const normal=(s:string)=>s.toLocaleLowerCase().replace(/\s+/g,' ').trim();
function unitPrice(price:string,per:string):string|null{try{const p=scaled(price,10),d=scaled(per);if(!d)return null;const numerator=p*1000000n;if(numerator%d)return null;const v=numerator/d,whole=v/10000000000n,decimal=String(v%10000000000n).padStart(10,'0').replace(/0+$/,'');return decimal?`${whole}.${decimal}`:String(whole);}catch{return null;}}
// The PAK and INV sheets may supplement one another only when the precise,
// two-row source layout and every item agree. Never infer a different match.
export function enrichMatchingInvoice(w:InvoiceWork,rows:PackingRow[]):boolean{
 const headers=rows.filter(r=>{const c=r.cells.map(normal);return c[1]==='code'&&c[2]==='description'&&c[3]==='country'&&c[6]==='manufacturer'&&c[8]==='brand'&&c[9]==='weight'&&c[10]==='qty pcs'&&c[11]==='price per'&&/^amount\s*,?$/.test(c[13]??'');});if(headers.length!==1)return false;
 const h=headers[0]!,sub=rows.find(r=>r.sheet===h.sheet&&r.row===h.row+1);if(!sub)return false;const c=sub.cells.map(normal);if(!/netto/.test(c[9]??'')||c[11]!=='usd'||c[12]!=='pcs'||c[13]!=='usd')return false;
 const invoiceRows=rows.filter(r=>r.sheet===h.sheet&&r.row>sub.row&&/^\d+$/.test((r.cells[0]??'').trim())&&/^\d{10}$/.test((r.cells[1]??'').trim()));if(invoiceRows.length!==w.items.length||!invoiceRows.length)return false;
 const selected:{item:typeof w.items[number];source:PackingRow;price:string;amount:string}[]=[];const used=new Set<string>();
 for(const item of w.items){const matches=invoiceRows.filter(r=>r.cells[1]===item.code&&normal(r.cells[2]??'')===normal(item.original)&&!used.has(r.id));if(matches.length!==1)return false;const r=matches[0]!;try{if(scaled(r.cells[10]??'')!==scaled(item.quantity)||!item.net||scaled(r.cells[9]??'')!==scaled(item.net))return false;if(item.maker&&normal(item.maker)!==normal(r.cells[6]??''))return false;if(item.origin&&normal(item.origin)!==normal(r.cells[3]??''))return false;const price=unitPrice(r.cells[11]??'',r.cells[12]??''),amount=r.cells[13]??'';if(!price||cents(amount)<0n)return false;selected.push({item,source:r,price,amount});used.add(r.id);}catch{return false;}}
 for(const x of selected){x.item.unit='pcs';x.item.unitPrice=x.price;x.item.amount=x.amount;const brand=(x.source.cells[8]??'').trim();if(brand&&!/^-+$/.test(brand))x.item.brand=brand;x.item.priceMismatch=cents(lineAmount(x.item.quantity,x.price))!==cents(x.amount);}
 w.currency='USD';w.warnings=[...(w.warnings??[]),'Цены и суммы сопоставлены с листом INV: проверьте каждый товар перед выпуском.'];return true;
}
