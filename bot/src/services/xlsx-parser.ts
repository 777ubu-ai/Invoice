import ExcelJS from 'exceljs';

export interface RawRow {
  rowNumber: number;
  cells: string[];
}

export interface ParsedPackingList {
  filename: string;
  totalRows: number;
  rows: RawRow[];
}

export async function parseXlsxBuffer(
  buf: Buffer,
  filename = 'file.xlsx',
): Promise<ParsedPackingList> {
  const wb = new ExcelJS.Workbook();
  // ExcelJS typing wants ArrayBuffer-backed Buffer; cast to any to avoid the
  // overly-strict type narrowing on Buffer vs Buffer<ArrayBufferLike>.
  await wb.xlsx.load(buf as any);
  const rows: RawRow[] = [];
  const ws = wb.worksheets[0];
  if (!ws) {
    return { filename, totalRows: 0, rows: [] };
  }

  ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    const cells: string[] = [];
    row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
      const v = cell.value;
      let text = '';
      if (v == null) text = '';
      else if (typeof v === 'object' && 'richText' in v && Array.isArray((v as any).richText)) {
        text = (v as any).richText.map((r: { text: string }) => r.text).join('');
      } else if (typeof v === 'object' && 'text' in v) {
        text = String((v as any).text);
      } else if (typeof v === 'object' && 'result' in v) {
        text = String((v as any).result ?? '');
      } else {
        text = String(v);
      }
      cells[colNumber - 1] = text.trim();
    });
    if (cells.some((c) => c)) {
      rows.push({ rowNumber, cells });
    }
  });

  return { filename, totalRows: rows.length, rows };
}

export function rowsAsText(parsed: ParsedPackingList, maxRows = 200): string {
  const head = `Файл: ${parsed.filename}\nСтрок с данными: ${parsed.totalRows}\n\n`;
  const body = parsed.rows
    .slice(0, maxRows)
    .map((r) => `R${r.rowNumber}: ${r.cells.map((c) => c || '·').join(' | ')}`)
    .join('\n');
  const tail =
    parsed.rows.length > maxRows ? `\n\n[... остальные ${parsed.rows.length - maxRows} строк опущены ...]` : '';
  return head + body + tail;
}
