import yauzl from 'yauzl';
import type {Company} from './commercial-types.js';
import {parsePackingXlsx,validateXlsxZip,MAX_UPLOAD_BYTES} from './packing-xlsx.js';
import type {CompanyProfile} from './company-profile.js';

export const emptyCompany=():Omit<Company,'id'>=>({name:'',country:'',address:'',taxId:'',bank:'',account:'',swift:'',contact:'',extra:''});
const labels:Record<string,keyof Omit<Company,'id'>>={
 'name':'name','company':'name','company name':'name','полное наименование организации':'name','наименование':'name','название':'name','название компании':'name',
 'страна':'country','country':'country','юридический адрес':'address','адрес':'address','address':'address','legal address':'address',
 'инн':'taxId','tax id':'taxId','registration number':'taxId','регистрационный номер':'taxId','банк':'bank','реквизиты банка':'bank','bank':'bank','банк получателя':'bank',
 'р/с':'account','счет':'account','счёт':'account','account':'account','account number':'account','р/с usd':'account','р/с rur':'account','р/с eur':'account',
 'swift':'swift','bic':'swift','бик':'swift','swift/bic':'swift','бик / swift':'swift','контакт':'contact','контакты':'contact','contact':'contact','телефон':'contact','дополнительно':'extra'};
const cleanLabel=(s:string)=>s.replace(/\s+/g,' ').trim().toLowerCase().replace(/[:：]+$/,'');
export function parseCompanyLines(lines:string[]):Omit<Company,'id'>{
 const data=emptyCompany();for(const line of lines){const cut=line.search(/[:：|]/);if(cut<1)continue;const k=labels[cleanLabel(line.slice(0,cut))];if(!k)continue;const v=line.slice(cut+1).trim();if(v&&v.length<=2000&&!data[k])data[k]=v;}
 return data;
}
export function fromBuyerProfile(p:CompanyProfile):Omit<Company,'id'>{const data=emptyCompany();data.name=p.name;const extra:string[]=[],accounts:string[]=[];for(const f of p.fields){if(/^р\/с(?:\s|$)/i.test(f.label)){accounts.push(`${f.label}: ${f.value}`);continue;}const k=labels[cleanLabel(f.label)];if(k&&!data[k])data[k]=f.value;else if(!k || (k!=='name'&&data[k]!==f.value))extra.push(`${f.label}: ${f.value}`);}data.account=accounts.join('\n');data.extra=extra.join('\n');return data;}

function xmlText(s:string):string{return s.replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/&amp;/g,'&').replace(/&#(\d+);/g,(_m,n:string)=>String.fromCodePoint(Number(n))).replace(/&#x([0-9a-f]+);/gi,(_m,n:string)=>String.fromCodePoint(parseInt(n,16)));}
async function docxText(buffer:Buffer):Promise<string[]> {
 await validateXlsxZip(buffer);
 return new Promise((resolve,reject)=>yauzl.fromBuffer(buffer,{lazyEntries:true,validateEntrySizes:true},(err,zip)=>{if(err||!zip){reject(new Error('Не удалось прочитать DOCX.'));return;}let found=false;zip.on('error',()=>reject(new Error('Не удалось прочитать DOCX.')));zip.on('entry',entry=>{if(entry.fileName!=='word/document.xml'){zip.readEntry();return;}found=true;zip.openReadStream(entry,(e,stream)=>{if(e||!stream){reject(new Error('Не удалось прочитать DOCX.'));return;}const chunks:Buffer[]=[];let len=0;stream.on('data',(b:Buffer)=>{len+=b.length;if(len>10_000_000){stream.destroy();reject(new Error('DOCX слишком большой.'));return;}chunks.push(b);});stream.on('error',()=>reject(new Error('Не удалось прочитать DOCX.')));stream.on('end',()=>{const xml=Buffer.concat(chunks).toString('utf8');const result:string[]=[];const getText=(part:string)=>[...part.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)].map(m=>xmlText(m[1]!)).join(' ').replace(/\s+/g,' ').trim();for(const row of xml.matchAll(/<w:tr(?:\s[^>]*)?>([\s\S]*?)<\/w:tr>/g)){const cells=[...row[1]!.matchAll(/<w:tc(?:\s[^>]*)?>([\s\S]*?)<\/w:tc>/g)].map(m=>getText(m[1]!)).filter(Boolean);if(cells.length&&/^\d+$/.test(cells[0]!))cells.shift();if(cells.length>1)result.push(`${cells[0]}: ${cells[1]}`);}const withoutTables=xml.replace(/<w:tbl(?:\s[^>]*)?>[\s\S]*?<\/w:tbl>/g,'');for(const para of withoutTables.matchAll(/<w:p(?:\s[^>]*)?>([\s\S]*?)<\/w:p>/g)){const value=getText(para[1]!);if(value)result.push(value);}resolve(result);zip.close();});});});zip.on('end',()=>{if(!found)reject(new Error('В DOCX нет текста.'));});zip.readEntry();}));
}
export async function readCompanyDocument(filename:string,buffer:Buffer):Promise<Omit<Company,'id'>> {
 if(!buffer.length||buffer.length>MAX_UPLOAD_BYTES)throw new Error('Файл пустой или больше 20 МБ.');
 const ext=filename.toLowerCase().split('.').pop();let lines:string[];
 if(ext==='xlsx'){const rows=await parsePackingXlsx(buffer);lines=rows.map(r=>r.cells.filter(Boolean).join(': '));}
 else if(ext==='docx')lines=await docxText(buffer);
 else if(ext==='pdf'){
  if(buffer.subarray(0,5).toString()!=='%PDF-')throw new Error('Некорректный PDF.');
  const {getDocument}=await import('pdfjs-dist/legacy/build/pdf.mjs');const pdf=await getDocument({data:new Uint8Array(buffer),useSystemFonts:true,isEvalSupported:false,disableFontFace:true}).promise;
  try{if(pdf.numPages>20)throw new Error('В PDF более 20 страниц.');lines=[];for(let i=1;i<=pdf.numPages;i++){const page=await pdf.getPage(i);const content=await page.getTextContent();let line='';for(const item of content.items){if('str'in item){line+=(line?' ':'')+item.str;if(item.hasEOL){lines.push(line);line='';}}}if(line)lines.push(line);}}finally{await pdf.destroy();}
 } else throw new Error('Поддерживаются XLSX, PDF и DOCX.');
 return parseCompanyLines(lines);
}
