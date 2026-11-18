import ExcelJS from 'exceljs';
import { resolve } from 'node:path';
import type { InvoiceWork } from './packing-invoice.js';

const blank='[УКАЗАТЬ]';
function numeric(value:string|undefined):number|null {
  if(!value || !/^\d{1,12}(?:\.\d{1,6})?$/.test(value))return null;
  // Excel stores only 15 significant decimal digits. Reject rather than silently alter values.
  if(value.replace('.','').replace(/^0+/,'').replace(/0+$/,'').length>15)throw new Error('Число слишком точное для Excel.');
  return Number(value);
}
function unitPrice(amount:string,quantity:string):string {
  if(!amount||!quantity)return '';
  const [aw,af='']=amount.split('.'),[qw,qf='']=quantity.split('.');
  const den=10n**BigInt(af.length)*BigInt(qw!+qf);if(!den)return '';
  const num=BigInt(aw!+af)*10n**BigInt(qf.length)*1000000n;
  const n=(num+den/2n)/den;return `${n/1000000n}.${String(n%1000000n).padStart(6,'0')}`;
}
function sum(values:(string|undefined)[],scale:number):number {
  let total=0n;for(const x of values){if(!x)continue;const [a,b='']=x.split('.');const frac=(b+'0'.repeat(scale+1)).slice(0,scale+1);const base=BigInt(a!)*10n**BigInt(scale)+BigInt(frac.slice(0,scale)||'0');total+=base+(Number(frac[scale])>=5?1n:0n);}
  if(total.toString().replace(/^0+/,'').replace(/0+$/,'').length>15)throw new Error('Итог слишком точный для Excel.');
  return Number(total)/10**scale;
}
export async function specificationWorkbook(work:InvoiceWork,final=false):Promise<Buffer> {
  if(work.items.length>1000)throw new Error('Слишком много позиций для шаблона.');
  const book=new ExcelJS.Workbook();await book.xlsx.readFile(resolve('assets/specification.xlsx'));
  const s=book.getWorksheet('Specification');if(!s)throw new Error('Шаблон не найден.');
  const shift=Math.max(0,work.items.length-7);
  const merges=[...(s.model.merges??[])].filter(x=>Number(x.match(/\d+/)?.[0])>=22);
  for(const m of merges)s.unMergeCells(m);
  if(shift)s.spliceRows(22,0,...Array.from({length:shift},()=>[]));
  for(const range of merges){const updated=range.replace(/([A-Z]+)(\d+)/g,(_m,col:string,row:string)=>`${col}${Number(row)+shift}`);s.mergeCells(updated);}
  const total=22+shift;
  s.getCell('B2').value=`СПЕЦИФИКАЦИЯ № ${work.invoiceNumber || blank}${final?'':' — ДЛЯ ПРОВЕРКИ'}`;
  s.getCell('B3').value=work.contract?`К контракту: ${work.contract}`:(final?'':`К контракту: ${blank}`);
  s.getCell('B4').value=final?'':'Место составления: '+blank;s.getCell('N4').value=work.invoiceDate||blank;
  s.getCell('B6').value=`Покупатель: ${work.buyer.name}. Получатель: ${work.consigneeDetails?.name||work.buyer.name}. Продавец: ${work.seller||blank}.`;
  s.getCell('B10').value=work.carrier||(final?'':blank);s.getCell('F10').value=work.driver||(final?'':blank);s.getCell('K10').value=work.vehicle||(final?'':blank);
  s.getCell('G11').value=work.loading||(final?'':blank);s.getCell('M11').value=work.delivery||(final?'':blank);
  const missing:ExcelJS.Fill={type:'pattern',pattern:'solid',fgColor:{argb:'FFFFF2CC'}};
  for(const [i,item] of work.items.entries()){
    const r=15+i,row=s.getRow(r),ref=s.getRow(21);if(r>=22){row.height=32;for(let c=1;c<=15;c++)row.getCell(c).style=structuredClone(ref.getCell(c).style);}
    const cells:(string|number|null)[]=[i+1,item.name,item.brand||null,item.code||null,item.maker||null,item.origin||null,numeric(item.quantity),numeric(item.packages),null,item.packaging||null,numeric(item.gross),numeric(item.net),numeric(item.unitPrice||unitPrice(item.amount,item.quantity)),({pcs:'ШТ',set:'КОМПЛЕКТ'} as Record<string,string>)[item.unit.toLowerCase()]||item.unit||null,numeric(item.amount)];
    cells.forEach((v,j)=>{const cell=row.getCell(j+1);cell.value=v;if(v===null)cell.fill=missing;});
    row.getCell(11).numFmt=(item.gross?.split('.')[1]?.length??0)>3?'#,##0.000000':'#,##0.000';row.getCell(12).numFmt=(item.net?.split('.')[1]?.length??0)>3?'#,##0.000000':'#,##0.000';row.getCell(13).numFmt='0.000000';row.getCell(15).numFmt=(item.amount?.split('.')[1]?.length??0)>2?'#,##0.000000':'#,##0.00';row.height=32;
  }
  // Clear spare example rows for short invoices.
  for(let r=15+work.items.length;r<total;r++)for(let c=1;c<=15;c++)s.getRow(r).getCell(c).value=null;
  const totals:[string,(string|undefined)[],number][]=[['G',work.items.map(x=>x.quantity),6],['H',work.items.map(x=>x.packages),0],['K',work.items.map(x=>x.gross),6],['L',work.items.map(x=>x.net),6],['O',work.items.map(x=>x.amount),6]];
  for(const [column,values,scale] of totals){const cell=s.getCell(`${column}${total}`);if(values.some(v=>!v)){cell.value=null;continue;}cell.value={formula:`SUM(${column}15:${column}${total-1})`,result:sum(values,scale)};if(column==='K'||column==='L')cell.numFmt=values.some(x=>(x?.split('.')[1]?.length??0)>3)?'#,##0.000000':'#,##0.000';if(column==='O')cell.numFmt=values.some(x=>(x?.split('.')[1]?.length??0)>2)?'#,##0.000000':'#,##0.00';if(column==='G')cell.numFmt=values.some(x=>(x?.split('.')[1]?.length??0)>0)?'#,##0.000000':'#,##0';}
  s.getCell('M14').value=`${work.currency||'?'} / ЕД.`;s.getCell('O14').value=work.currency||'?';
  s.getCell(`C${24+shift}`).value=work.terms||(final?'':blank);s.getCell(`B${25+shift}`).value='';s.getCell(`C${26+shift}`).value=work.terms||(final?'':blank);s.getCell(`B${27+shift}`).value='';
  const concise=(profile:NonNullable<typeof work.sellerDetails>)=>profile.fields.filter(f=>f.label!=='Дополнительно').map(f=>`${f.label}: ${f.value}`).filter(Boolean).join('\n');
  const heightFor=(value:string,width:number)=>Math.min(409,Math.max(30,value.split('\n').reduce((n,line)=>n+Math.max(1,Math.ceil(line.length/width)),0)*12+10));
  const recipient=work.consigneeDetails??work.buyer;
  s.getCell(`B${30+shift}`).value=work.buyer.name;s.getCell(`B${31+shift}`).value=concise(work.buyer);
  s.getCell(`B${36+shift}`).value=recipient.name;s.getCell(`B${37+shift}`).value=concise(recipient);
  for(const row of [31+shift,37+shift]){s.getCell(`B${row}`).alignment={wrapText:true,vertical:'top'};s.getRow(row).height=heightFor(String(s.getCell(`B${row}`).value??''),90);}
  s.getCell(`L${30+shift}`).value=work.sellerDetails?`${work.sellerDetails.name}\n${concise(work.sellerDetails)}`:work.seller||blank;
  s.getCell(`L${30+shift}`).alignment={wrapText:true,vertical:'top'};s.getRow(30+shift).height=heightFor(String(s.getCell(`L${30+shift}`).value??''),40);
  for(const row of [32+shift,33+shift,38+shift,39+shift])s.getCell(`B${row}`).value='';
  const company=book.addWorksheet('Участники');company.pageSetup={fitToPage:true,fitToWidth:1,fitToHeight:0,orientation:'portrait'};company.columns=[{width:38},{width:110}];
  for(const [label,profile] of [['Продавец',work.sellerDetails],['Отправитель',work.shipperDetails],['Покупатель',work.buyer],['Получатель',recipient],['Плательщик',work.payerDetails]] as const){if(!profile)continue;company.addRow([label,profile.name]);for(const f of profile.fields)company.addRow([f.label,f.value]);company.addRow([]);}
  company.eachRow(row=>{row.alignment={vertical:'top',wrapText:true};row.height=heightFor(String(row.getCell(2).value??''),100);});
  const audit=book.addWorksheet('Прочие строки');audit.pageSetup={fitToPage:true,fitToWidth:1,fitToHeight:0,orientation:'landscape'};audit.columns=[{header:'Лист',width:24},{header:'Строка',width:12},{header:'Причина',width:28},{header:'Исходные ячейки',width:110}];
  for(const x of work.omitted)audit.addRow([x.sheet,x.row,x.reason,x.cells.join(' | ')]);
  book.calcProperties.fullCalcOnLoad=true;
  return Buffer.from(await book.xlsx.writeBuffer());
}
