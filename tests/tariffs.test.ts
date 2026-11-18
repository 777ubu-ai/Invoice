import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findPrices, pricesMessage } from '../src/tariffs.js';

test('exact code lookup preserves all sources and reports historical data without choosing a price', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tariff-test-'));
  try {
    const path = join(dir, 'grid.json');
    await writeFile(path, JSON.stringify({ datasets: [
      { id: 1, file: 'source1.xlsx', sheet: 'Лист1', rows: [
        { code: '0012345678', price_usd_kg: 1.2, source_row: 2, description: 'товар А' },
        { code: '1012345678', price_usd_kg: 3, source_row: 3 },
      ] },
      { id: 3, file: 'source3.xlsx', sheet: 'ТНП', rows: [
        { code: '0012345678', price_usd_kg: 2.5, source_row: 9, description: 'товар Б' },
      ] },
    ] }));
    const rows = await findPrices(path, '0012345678');
    assert.equal(rows.length, 2);
    const result = pricesMessage('0012345678', rows);
    assert.match(result, /source1.xlsx, Лист1, строка 2/);
    assert.match(result, /source3.xlsx, ТНП, строка 9/);
    assert.match(result, /1\.2 USD\/кг/);
    assert.match(result, /2\.5 USD\/кг/);
    assert.match(result, /2025 года/);
    assert.doesNotMatch(result, /3 USD/);
    await assert.rejects(findPrices(path, '12345678'));
    assert.match(pricesMessage('9999999999', await findPrices(path, '9999999999')), /не найден/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('damaged or absent source fails without inventing a price', async () => {
  await assert.rejects(findPrices('/missing/tariff.json', '0012345678'));
});
