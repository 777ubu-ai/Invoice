import ExcelJS from 'exceljs';
import yauzl from 'yauzl';

export type PackingRow = { id:string; sheet:string; row:number; cells:string[] };
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

export async function validateXlsxZip(buf: Buffer): Promise<void> {
  if (!buf.length || buf.length > MAX_UPLOAD_BYTES) throw new Error('Файл пустой или больше 20 МБ.');
  return new Promise((resolve,reject) => {
    yauzl.fromBuffer(buf,{lazyEntries:true,validateEntrySizes:true},(err,zip) => {
      if (err || !zip) { reject(new Error('Файл не является корректным XLSX.')); return; }
      let count=0, total=0, done=false;
      const fail = () => { if (!done) { done=true; zip.close(); reject(new Error('Файл повреждён или слишком большой после распаковки.')); } };
      zip.on('error',fail);
      zip.on('entry',entry => {
        count++; total += entry.uncompressedSize;
        if (count > 3000 || total > 100*1024*1024 || entry.uncompressedSize > 50*1024*1024) { fail(); return; }
        zip.readEntry();
      });
      zip.on('end',() => { if (!done) { done=true; resolve(); } });
      zip.readEntry();
    });
  });
}

function cellText(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString().slice(0,10);
  if (typeof value === 'object') {
    if ('richText' in value && Array.isArray(value.richText)) return value.richText.map(x => x.text).join('');
    if ('result' in value) return value.result == null ? '' : String(value.result);
    if ('text' in value && typeof value.text === 'string') return value.text;
    return '';
  }
  return String(value);
}

export async function parsePackingXlsx(buf: Buffer): Promise<PackingRow[]> {
  await validateXlsxZip(buf);
  const book = new ExcelJS.Workbook();
  try { await book.xlsx.load(buf as never); }
  catch { throw new Error('Не удалось прочитать XLSX.'); }
  if (book.worksheets.length > 8) throw new Error('Больше 8 листов. Разделите файл.');
  const rows: PackingRow[]=[];
  for (const [sheetIndex,sheet] of book.worksheets.entries()) {
    if (sheet.rowCount > 3000 || sheet.columnCount > 100) throw new Error('Слишком много строк или столбцов. Разделите файл.');
    sheet.eachRow({includeEmpty:false},(row,rowNumber) => {
      const cells:string[]=[];
      row.eachCell({includeEmpty:true},(cell,col) => {
        const text=cellText(cell.value).trim();
        if (text.length > 2000) throw new Error('Слишком длинная ячейка в XLSX.');
        cells[col-1]=text;
      });
      for (let i=0;i<cells.length;i++) cells[i] ??= '';
      if (cells.some(Boolean)) rows.push({id:`s${sheetIndex}r${rowNumber}`,sheet:sheet.name,row:rowNumber,cells});
    });
  }
  if (!rows.length) throw new Error('В файле нет данных.');
  if (rows.length > 150) throw new Error('Больше 150 непустых строк. Разделите packing на несколько файлов.');
  if (JSON.stringify(rows).length > 180_000) throw new Error('Слишком много текста в файле. Разделите packing.');
  return rows;
}
