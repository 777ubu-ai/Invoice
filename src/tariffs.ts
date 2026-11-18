import { readFile, stat } from 'node:fs/promises';

type Entry = { code?: unknown; price_usd_kg?: unknown; description?: unknown; source_row?: unknown; date?: unknown };
type Dataset = { id?: unknown; file?: unknown; sheet?: unknown; rows?: unknown };
type Match = { source: string; sheet: string; row: number; price: number; description: string; date: string };

export async function findPrices(path: string, code: string): Promise<Match[]> {
  if (!/^\d{10}$/.test(code)) throw new Error('invalid_code');
  if ((await stat(path)).size > 20_000_000) throw new Error('grid_too_large');
  const document: unknown = JSON.parse(await readFile(path, 'utf8'));
  if (!document || typeof document !== 'object' || !Array.isArray((document as {datasets?: unknown}).datasets)) throw new Error('invalid_grid');
  const datasets = (document as {datasets: Dataset[]}).datasets;
  const matches: Match[] = [];
  for (const set of datasets) {
    if (![1,2,3].includes(Number(set.id)) || typeof set.file !== 'string' || typeof set.sheet !== 'string' || !Array.isArray(set.rows)) continue;
    for (const raw of set.rows as Entry[]) {
      if (String(raw.code) !== code || typeof raw.price_usd_kg !== 'number' || !Number.isFinite(raw.price_usd_kg) || raw.price_usd_kg <= 0 || !Number.isInteger(raw.source_row)) continue;
      matches.push({ source: set.file, sheet: set.sheet, row: raw.source_row as number, price: raw.price_usd_kg,
        description: typeof raw.description === 'string' ? raw.description : '', date: typeof raw.date === 'string' ? raw.date : '' });
    }
  }
  return matches;
}

export function pricesMessage(code: string, rows: Match[]): string {
  const head = `Сетка Сармант · код ${code}\nДанные источников 2025 года. Проверьте актуальность и соответствие товару.\nЦена — ориентир USD/кг нетто, не сумма платежей и не утверждённая стоимость.\n`;
  if (!rows.length) return head + '\nТочный код с указанной ценой не найден.';
  const lines: string[] = [];
  let length = head.length;
  for (const row of rows) {
    const description = row.description.replace(/\s+/g, ' ').slice(0, 150);
    const line = `\n${row.price} USD/кг · ${row.source}, ${row.sheet}, строка ${row.row}${row.date ? ` · ${row.date}` : ''}${description ? `\n${description}` : ''}\n`;
    if (length + line.length > 3400 || lines.length >= 12) break;
    lines.push(line); length += line.length;
  }
  return head + lines.join('') + (lines.length < rows.length ? `\nПоказано ${lines.length} из ${rows.length}. Уточните по исходному файлу.` : '');
}
