import yauzl from 'yauzl';
import {MAX_UPLOAD_BYTES,parsePackingXlsx,validateXlsxZip,type PackingRow} from './packing-xlsx.js';

function csvRows(buffer:Buffer):PackingRow[]{
 let text:string;
 try{if(buffer.subarray(0,2).equals(Buffer.from([0xff,0xfe])))text=new TextDecoder('utf-16le',{fatal:true}).decode(buffer.subarray(2));else text=new TextDecoder('utf-8',{fatal:true}).decode(buffer);}catch{try{text=new TextDecoder('windows-1251',{fatal:true}).decode(buffer);}catch{throw new Error('Не удалось прочитать кодировку CSV. Сохраните файл в UTF-8.');}}
 text=text.replace(/^\uFEFF/,'');if(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text))throw new Error('Это не текстовая таблица CSV.');
 // Delimiters are chosen outside quoted fields so decimal commas remain intact.
 const scores=new Map([[';',0],[',',0],['\t',0]]);let quoted=false;
 for(let i=0;i<text.length;i++){const c=text[i]!;if(c==='"'){if(quoted&&text[i+1]==='"')i++;else quoted=!quoted;}else if(!quoted&&(c==='\n'||c==='\r'))break;else if(!quoted&&scores.has(c))scores.set(c,scores.get(c)!+1);}
 const delimiter=[...scores].sort((a,b)=>b[1]-a[1])[0]!;if(!delimiter[1])throw new Error('В CSV не найдены столбцы. Нужна таблица с товарами и количеством.');
 const rows:PackingRow[]=[];let cells:string[]=[],cell='',inQuotes=false,afterQuote=false,rowNo=1;
 const pushCell=()=>{if(cell.length>2000)throw new Error('Слишком длинная ячейка CSV.');cells.push(cell.trim());if(cells.length>100)throw new Error('В CSV слишком много столбцов.');cell='';afterQuote=false;};
 const pushRow=()=>{pushCell();if(rowNo===1&&cells.some(x=>/^(?:username|user_name|telegram_username)$/i.test(x))&&!cells.some(x=>/^(?:товар|наименование|наименование товара|description|product name)$/i.test(x)))throw new Error('В файле не найдена таблица товаров. Загрузите Packing List.');if(cells.some(Boolean))rows.push({id:`s0r${rowNo}`,sheet:'CSV',row:rowNo,cells});if(rows.length>1000)throw new Error('В таблице больше 1000 строк. Разделите Packing List на части.');cells=[];rowNo++;};
 for(let i=0;i<text.length;i++){const c=text[i]!;if(inQuotes){if(c==='"'){if(text[i+1]==='"'){cell+='"';i++;}else{inQuotes=false;afterQuote=true;}}else cell+=c;continue;}if(c==='"'){if(cell.trim()||afterQuote)throw new Error('Проверьте кавычки в CSV.');inQuotes=true;continue;}if(c===delimiter[0]){pushCell();continue;}if(c==='\r'||c==='\n'){if(c==='\r'&&text[i+1]==='\n')i++;pushRow();continue;}if(afterQuote&&c!==' '&&c!=='\t')throw new Error('Проверьте кавычки в CSV.');if(!afterQuote)cell+=c;}
 if(inQuotes)throw new Error('В CSV не закрыта кавычка.');if(cell||cells.length)pushRow();if(!rows.length)throw new Error('В CSV нет данных.');return rows;
}

async function zipFile(buffer:Buffer):Promise<{name:string;buffer:Buffer}>{
 await validateXlsxZip(buffer);
 return new Promise((resolve,reject)=>yauzl.fromBuffer(buffer,{lazyEntries:true,validateEntrySizes:true},(err,zip)=>{
  if(err||!zip){reject(new Error('Не удалось открыть ZIP.'));return;}let selected:{name:string;buffer:Buffer}|undefined,failed=false;
  const fail=(message:string)=>{if(!failed){failed=true;zip.close();reject(new Error(message));}};
  zip.on('error',()=>fail('Архив повреждён.'));zip.on('entry',entry=>{
   const parts=entry.fileName.replace(/\\/g,'/').split('/');if(parts.includes('..')||entry.fileName.startsWith('/')||/^[A-Za-z]:/.test(entry.fileName)){fail('В ZIP обнаружен недопустимый путь.');return;}
   if(entry.fileName.endsWith('/')||entry.fileName.startsWith('__MACOSX/')||parts.at(-1)?.startsWith('.')){zip.readEntry();return;}
   if(!/\.(xlsx|csv)$/i.test(entry.fileName)){fail('В ZIP должен быть один файл packing в формате XLSX или CSV.');return;}
   if(selected){fail('В ZIP несколько файлов. Пришлите один packing-файл в архиве.');return;}
   if(entry.isEncrypted()||entry.uncompressedSize>MAX_UPLOAD_BYTES){fail('Файл в архиве защищён паролем или превышает 20 МБ.');return;}
   zip.openReadStream(entry,(e,stream)=>{if(e||!stream){fail('Не удалось прочитать файл в ZIP.');return;}const chunks:Buffer[]=[];let size=0;stream.on('data',(part:Buffer)=>{size+=part.length;if(size>MAX_UPLOAD_BYTES){stream.destroy();fail('Файл в ZIP больше 20 МБ.');return;}chunks.push(part);});stream.on('error',()=>fail('Не удалось прочитать файл в ZIP.'));stream.on('end',()=>{if(failed)return;selected={name:parts.at(-1)!,buffer:Buffer.concat(chunks)};zip.readEntry();});});
  });zip.on('end',()=>{if(!failed){if(selected)resolve(selected);else reject(new Error('В ZIP нет файла XLSX или CSV.'));}});zip.readEntry();
 }));
}

type PdfText={str:string;transform:number[]};
async function pdfRows(buffer:Buffer):Promise<PackingRow[]>{
 if(buffer.subarray(0,5).toString()!=='%PDF-')throw new Error('Некорректный PDF.');
 const {getDocument}=await import('pdfjs-dist/legacy/build/pdf.mjs');const pdf=await getDocument({data:new Uint8Array(buffer),useSystemFonts:true,isEvalSupported:false,disableFontFace:true}).promise;
 try{if(pdf.numPages!==1)throw new Error('Многостраничный PDF сохранён, но пока не разбирается автоматически. Отправьте таблицу XLSX или CSV.');const rows:PackingRow[]=[];
  for(let pageNo=1;pageNo<=pdf.numPages;pageNo++){const page=await pdf.getPage(pageNo),content=await page.getTextContent(),lines:{y:number;parts:PdfText[]}[]=[];
   for(const item of content.items){if(!('str'in item)||!item.str.trim())continue;const p=item as PdfText;if(!Array.isArray(p.transform)||!Number.isFinite(p.transform[4])||!Number.isFinite(p.transform[5]))continue;let line=lines.find(x=>Math.abs(x.y-p.transform[5]!)<=2);if(!line){line={y:p.transform[5]!,parts:[]};lines.push(line);}line.parts.push(p);}
   lines.sort((a,b)=>b.y-a.y);let anchors:number[]|undefined;
   for(const line of lines){const parts=line.parts.sort((a,b)=>a.transform[4]!-b.transform[4]!);if(!anchors){const vals=parts.map(x=>x.str.trim().toLowerCase());if(vals.some(x=>/^(description|product name|наименование|наименование товара|товар|описание товара)$/.test(x))&&vals.some(x=>/^(qty|quantity|количество|кол-во)$/.test(x))){anchors=parts.map(x=>x.transform[4]!);if(new Set(anchors).size!==anchors.length){anchors=undefined;continue;}const rowNo=rows.length+1;rows.push({id:`s${pageNo-1}r${rowNo}`,sheet:`PDF ${pageNo}`,row:rowNo,cells:parts.map(p=>p.str.trim())});}continue;}
    const cells=Array<string>(anchors.length).fill('');for(const p of parts){const x=p.transform[4]!;let col=-1;for(let i=0;i<anchors.length;i++)if(x>=anchors[i]!-2)col=i;else break;if(col>=0)cells[col]+=(cells[col]?' ':'')+p.str.trim();}
    if(cells.some(Boolean)){const rowNo=rows.length+1;rows.push({id:`s${pageNo-1}r${rowNo}`,sheet:`PDF ${pageNo}`,row:rowNo,cells});if(rows.length>1000)throw new Error('В PDF слишком много строк.');}
   }
  }
  if(!rows.length)throw new Error('PDF сохранён, но таблицу не удалось надёжно прочитать. Если это скан, пришлите Excel или CSV.');return rows;
 }finally{await pdf.destroy();}
}

export async function parsePackingImport(filename:string,buffer:Buffer):Promise<PackingRow[]>{
 if(!buffer.length||buffer.length>MAX_UPLOAD_BYTES)throw new Error('Файл пустой или больше 20 МБ.');
 const ext=filename.toLowerCase().split('.').pop();
 if(ext==='xlsx')return parsePackingXlsx(buffer);
 if(ext==='csv')return csvRows(buffer);
 if(ext==='pdf')return pdfRows(buffer);
 if(ext==='zip'){const inner=await zipFile(buffer);return /\.xlsx$/i.test(inner.name)?parsePackingXlsx(inner.buffer):csvRows(inner.buffer);}
 throw new Error('Файл сохранён, но этот формат пока нельзя прочитать. Отправьте XLSX, CSV, PDF с текстовой таблицей или ZIP с одним XLSX/CSV.');
}
