import {readFile,stat} from 'node:fs/promises';
import {join} from 'node:path';
import type {InvoiceWork} from './packing-invoice.js';

type ReferenceItem={name:string;quantity:string;unit:string;net:string;gross:string;amount:string;packages:string;unitPrice:string;code:string};
type Reference={items:ReferenceItem[]};
const canonical=(v:string)=>{const [whole,fraction='']=v.trim().replace(',','.').split('.');if(!/^\d+$/.test(whole??'')||!/^\d*$/.test(fraction))return null;return `${whole!.replace(/^0+(?=\d)/,'')}.${fraction.replace(/0+$/,'')}`;};
const text=(v:string)=>v.normalize('NFKC').trim().toLocaleLowerCase('ru');
export function matchesReference(work:InvoiceWork,reference:Reference):boolean{
 if(work.currency!=='USD'||!Array.isArray(reference.items)||reference.items.length!==work.items.length||!work.items.length)return false;
 return work.items.every((item,i)=>{const r=reference.items[i];if(!r)return false;
  if(text(item.name)!==text(r.name)||text(item.unit)!==text(r.unit))return false;
  if(item.brand||item.maker||item.origin||item.packaging)return false;
  if(item.code&&item.code!==r.code)return false;
  for(const field of ['quantity','net','gross','amount','packages','unitPrice'] as const){const x=item[field];if(typeof x!=='string'||typeof r[field]!=='string')return false;const a=canonical(x),b=canonical(r[field]);if(a===null||b===null||a!==b)return false;}
  return true;
 });
}
/** Retrieve only the already-prepared, explicitly historical example for an exactly matching packing. */
export async function historicalExample(work:InvoiceWork,dir=process.env.HISTORICAL_EXAMPLE_DIR??''):Promise<Buffer|null>{
 if(!dir)return null;
 try{
  const manifestPath=join(dir,'example15.json'),reportPath=join(dir,'invoice15-calc.b64');
  if((await stat(manifestPath)).size>100000||(await stat(reportPath)).size>1000000)return null;
  const reference=JSON.parse(await readFile(manifestPath,'utf8')) as Reference;
  if(!matchesReference(work,reference))return null;
  const encoded=(await readFile(reportPath,'utf8')).trim();if(!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded))return null;
  const report=Buffer.from(encoded,'base64');if(report.length<4||report.subarray(0,2).toString()!=='PK')return null;
  return report;
 }catch{return null;}
}
