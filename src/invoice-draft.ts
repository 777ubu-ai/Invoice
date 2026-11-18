import { randomUUID } from 'node:crypto';
import ExcelJS from 'exceljs';
import type { Pool } from 'pg';

export type Item = { description: string; quantity: string; unit: string; unitPrice: string; cents: string };
export type Draft = { id: string; createdBy: number; number: string; date: string; seller: string; buyer: string; currency: string; items: Item[]; totalCents: string };
export const CURRENCIES = ['USD','EUR','RUB','KZT','CNY'] as const;

function cleanField(s: string, limit: number): string {
  const v = s.trim();
  if (!v || v.length > limit || /[\r\n\u0000-\u001f]/.test(v)) throw new Error('field');
  return v;
}
export function valueField(s: string, limit = 500): string { return cleanField(s, limit); }
export function dateField(s: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new Error('date');
  const date = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(date.valueOf()) || date.toISOString().slice(0,10) !== s) throw new Error('date');
  return s;
}
function scaled(s: string): { digits: bigint; scale: bigint; display: string } {
  const v = s.trim().replace(',', '.');
  if (!/^\d{1,12}(?:\.\d{1,6})?$/.test(v)) throw new Error('number');
  const [whole, fraction = ''] = v.split('.');
  return { digits: BigInt(whole! + fraction), scale: 10n ** BigInt(fraction.length), display: v };
}
export function parseItems(text: string): Item[] {
  const lines = text.trim().split(/\r?\n/);
  if (!lines.length || lines.length > 100) throw new Error('items');
  return lines.map(line => {
    const parts = line.split('|');
    if (parts.length !== 4) throw new Error('items');
    const description = cleanField(parts[0]!, 300), unit = cleanField(parts[2]!, 30);
    const qty = scaled(parts[1]!), price = scaled(parts[3]!);
    if (qty.digits === 0n) throw new Error('quantity');
    const product = qty.digits * price.digits * 100n, denominator = qty.scale * price.scale;
    const cents = (product + denominator / 2n) / denominator;
    return {description, quantity: qty.display, unit, unitPrice: price.display, cents: cents.toString()};
  });
}
export function money(cents: bigint): string {
  return `${cents / 100n}.${String(cents % 100n).padStart(2,'0')}`;
}
export function createDraft(createdBy: number, data: Omit<Draft,'id'|'createdBy'|'totalCents'>): Draft {
  return {id:randomUUID(),createdBy,...data,totalCents:data.items.reduce((s,v) => s + BigInt(v.cents), 0n).toString()};
}

export interface InvoiceDraftStore { saveDraft(draft: Draft): Promise<void> }
export class InvoiceStore implements InvoiceDraftStore {
  constructor(private pool: Pool) {}
  async saveDraft(d: Draft) {
    await this.pool.query(`INSERT INTO packing_invoice_v2.invoice_drafts
      (id,created_by,invoice_number,invoice_date,seller,buyer,currency,items,total_cents)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9) ON CONFLICT (id) DO NOTHING`,
    [d.id,d.createdBy,d.number,d.date,d.seller,d.buyer,d.currency,JSON.stringify(d.items),d.totalCents]);
  }
}

export async function draftWorkbook(d: Draft): Promise<Buffer> {
  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet('Invoice draft');
  sheet.columns = [{width:7},{width:48},{width:18},{width:15},{width:20},{width:20}];
  sheet.addRow(['ЧЕРНОВИК / DRAFT — не выпущенный инвойс']);
  sheet.addRow(['Номер',d.number]); sheet.addRow(['Дата',d.date]);
  sheet.addRow(['Продавец',d.seller]); sheet.addRow(['Покупатель',d.buyer]); sheet.addRow(['Валюта',d.currency]);
  sheet.addRow(['№','Наименование','Количество','Ед.','Цена за ед.','Сумма']);
  d.items.forEach((item,index) => sheet.addRow([index+1,item.description,item.quantity,item.unit,item.unitPrice,money(BigInt(item.cents))]));
  sheet.addRow(['','ИТОГО','','','',money(BigInt(d.totalCents))]);
  sheet.addRow(['Проверить реквизиты, договор, условия оплаты и поставки перед выпуском.']);
  sheet.getRow(1).font = {bold:true}; sheet.getRow(7).font = {bold:true};
  sheet.views = [{state:'frozen',ySplit:7}];
  return Buffer.from(await book.xlsx.writeBuffer());
}
