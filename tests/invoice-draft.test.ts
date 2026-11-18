import test from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import type { Pool } from 'pg';
import { createDraft, dateField, draftWorkbook, InvoiceStore, money, parseItems } from '../src/invoice-draft.js';

test('manual line totals use exact decimal arithmetic and reject invalid data', () => {
  const items = parseItems('Товар А | 3 | шт | 0.10\nТовар Б | 2.5 | кг | 1.235');
  assert.deepEqual(items.map(i => i.cents), ['30','309']);
  assert.equal(money(items.reduce((s,i) => s+BigInt(i.cents),0n)), '3.39');
  assert.throws(() => parseItems('Товар | 0 | шт | 10'));
  assert.throws(() => parseItems('Товар | -1 | шт | 10'));
  assert.throws(() => parseItems('Товар | 1 | шт'));
  assert.throws(() => parseItems('Товар | 1e3 | шт | 10'));
  assert.throws(() => dateField('2026-02-30'));
  assert.equal(dateField('2026-11-18'), '2026-11-18');
});

test('draft persistence is idempotent and XLSX labels the document as a draft', async () => {
  const db = new PGlite();
  try {
    for (const name of ['001_foundation.sql','002_invoice_drafts.sql','003_buyer_details.sql']) {
      await db.exec(await readFile(new URL(`../migrations/${name}`,import.meta.url),'utf8'));
    }
    const store = new InvoiceStore(db as unknown as Pool);
    const d = createDraft(42,{number:'TEST-1',date:'2026-11-18',seller:'Продавец',buyer:'Покупатель',buyerDetails:{name:'Покупатель',fields:[{label:'ИНН',value:'123'}]},currency:'USD',items:parseItems('Товар | 3 | шт | 1.25')});
    await store.saveDraft(d); await store.saveDraft(d);
    const result = await db.query<{total_cents: string; created_by: string}>('SELECT total_cents, created_by FROM packing_invoice_v2.invoice_drafts');
    assert.equal(result.rows.length,1);
    assert.equal(String(result.rows[0]!.total_cents),'375');
    const book = new ExcelJS.Workbook();
    await book.xlsx.load(await draftWorkbook(d) as never);
    const sheet = book.getWorksheet('Invoice draft')!;
    assert.match(String(sheet.getCell('A1').value),/ЧЕРНОВИК/);
    assert.equal(sheet.getCell('F8').value,'3.75');
    assert.equal(sheet.getCell('F9').value,'3.75');
    assert.equal(book.getWorksheet('Реквизиты покупателя')!.getCell('B2').value,'123');
    const details = await db.query<{buyer_details:{name:string}}> ('SELECT buyer_details FROM packing_invoice_v2.invoice_drafts');
    assert.equal(details.rows[0]!.buyer_details.name,'Покупатель');
  } finally { await db.close(); }
});
