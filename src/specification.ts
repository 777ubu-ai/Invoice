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
  if(work.items.length>150)throw new Error('Слишком много позиций для шаблона.');
  const book=new ExcelJS.Workbook();await book.xlsx.readFile(resolve('assets/specification.xlsx'));
  const s=book.getWorksheet('Specification');if(!s)throw new Error('Шаблон не найден.');
  const shift=Math.max(0,work.items.length-7);
  const merges=[...(s.model.merges??[])].filter(x=>Number(x.match(/\d+/)?.[0])>=22);
  for(const m of merges)s.unMergeCells(m);
  if(shift)s.spliceRows(22,0,...Array.from({length:shift},()=>[]));
  for(const range of merges){const updated=range.replace(/([A-Z]+)(\d+)/g,(_m,col:string,row:string)=>`${col}${Number(row)+shift}`);s.mergeCells(updated);}
  const total=22+shift;
  s.getCell('B2').value=`СПЕЦИФИКАЦИЯ № ${work.invoiceNumber || blank}${final?'':' — ДЛЯ ПРОВЕРКИ'}`;
  s.getCell('B3').value=`К контракту: ${work.contract || blank}`;
  s.getCell('B4').value='Место составления: '+blank;s.getCell('N4').value=work.invoiceDate||blank;
  s.getCell('B6').value=`${work.buyer.name} — покупатель и получатель. Продавец: ${work.seller||blank}.`;
  s.getCell('B10').value=work.carrier||blank;s.getCell('F10').value=work.driver||blank;s.getCell('K10').value=work.vehicle||blank;
  s.getCell('G11').value=work.loading||blank;s.getCell('M11').value=work.delivery||blank;
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
  for(const [column,values,scale] of totals){const cell=s.getCell(`${column}${total}`);cell.value={formula:`SUM(${column}15:${column}${total-1})`,result:sum(values,scale)};if(column==='K'||column==='L')cell.numFmt=values.some(x=>(x?.split('.')[1]?.length??0)>3)?'#,##0.000000':'#,##0.000';if(column==='O')cell.numFmt=values.some(x=>(x?.split('.')[1]?.length??0)>2)?'#,##0.000000':'#,##0.00';if(column==='G')cell.numFmt=values.some(x=>(x?.split('.')[1]?.length??0)>0)?'#,##0.000000':'#,##0';}
  s.getCell('M14').value=`${work.currency||'?'} / ЕД.`;s.getCell('O14').value=work.currency||'?';
  s.getCell(`C${24+shift}`).value=work.terms||blank;s.getCell(`B${25+shift}`).value='';s.getCell(`C${26+shift}`).value=work.terms||blank;s.getCell(`B${27+shift}`).value='';
  const wanted=/^(Юридический адрес|ИНН|КПП|ОГРН|Реквизиты банка|Р\/с RUR|Р\/с USD|К\/с|БИК \/ SWIFT)$/i;
  const detail=work.buyer.fields.filter(f=>wanted.test(f.label)).map(f=>`${f.label}: ${f.value}`).join('\n');
  for(const row of [30+shift,36+shift])s.getCell(`B${row}`).value=work.buyer.name;
  for(const row of [31+shift,37+shift]){s.getCell(`B${row}`).value=detail;s.getCell(`B${row}`).alignment={wrapText:true,vertical:'top'};s.getRow(row).height=175;}
  s.getCell(`L${30+shift}`).value=work.seller||blank;
  for(const row of [32+shift,33+shift,38+shift,39+shift])s.getCell(`B${row}`).value='';
  const company=book.addWorksheet('Реквизиты ПТК');company.columns=[{width:38},{width:110}];company.addRow(['Покупатель и получатель',work.buyer.name]);for(const f of work.buyer.fields)company.addRow([f.label,f.value]);company.eachRow(row=>{row.alignment={vertical:'top',wrapText:true};});
  const audit=book.addWorksheet('Прочие строки');audit.columns=[{header:'Лист',width:24},{header:'Строка',width:12},{header:'Причина',width:28},{header:'Исходные ячейки',width:110}];
  for(const x of work.omitted)audit.addRow([x.sheet,x.row,x.reason,x.cells.join(' | ')]);
  book.calcProperties.fullCalcOnLoad=true;
  return Buffer.from(await book.xlsx.writeBuffer());
}
