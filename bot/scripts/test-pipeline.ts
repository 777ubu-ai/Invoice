// Smoke test the 3-agent classification pipeline against a real xlsx file.
// Run: ANTHROPIC_API_KEY=... npx tsx scripts/test-pipeline.ts /path/to/packing.xlsx
import { readFileSync } from 'node:fs';
import { parseXlsxBuffer, rowsAsText } from '../src/services/xlsx-parser.js';
import { runClassificationPipeline } from '../src/services/classifier.js';

async function main() {
  const path = process.argv[2];
  if (!path) {
    console.error('Usage: tsx scripts/test-pipeline.ts <xlsx-path>');
    process.exit(1);
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('Set ANTHROPIC_API_KEY first');
    process.exit(1);
  }

  console.log(`\n=== Reading ${path} ===`);
  const buf = readFileSync(path);
  const parsed = await parseXlsxBuffer(buf, path);
  console.log(`Parsed ${parsed.totalRows} rows from xlsx`);
  if (parsed.rows.length > 0) {
    console.log('First 3 rows of file:');
    for (const r of parsed.rows.slice(0, 3)) {
      console.log(`  R${r.rowNumber}: ${r.cells.slice(0, 8).join(' | ')}`);
    }
  }

  console.log('\n=== Running 5-agent pipeline (Лаура + Маке) ===');
  const fileText = rowsAsText(parsed);
  const result = await runClassificationPipeline(
    fileText,
    { mode: 'TARGET_PAYMENTS', value: 8500, defaultPricePerKg: 0.75 },
    (p) => {
      console.log(`[stage ${p.stage}] ${p.label}`);
    },
  );
  const reviewed = result.items;

  console.log(`\n=== Pipeline returned ${reviewed.length} items ===`);
  console.log('\n--- Лаура (финансист) ---');
  console.log(`Стоимость партии: $${result.financials.cost_usd}`);
  console.log(`Пошлина (сумма):  $${result.financials.duty_usd}`);
  console.log(`НДС 16%:          $${result.financials.vat_usd}`);
  console.log(`Сбор тамож.:      $${result.financials.fee_usd}`);
  console.log(`ИТОГО ПЛАТЕЖЕЙ:   $${result.financials.total_payments_usd} (цель $${result.financials.target_usd})`);
  console.log(`Заметка:          ${result.laura_notes}`);
  console.log('\n--- Маке (главный) ---');
  console.log(`approved: ${result.make.approved}`);
  console.log(`warnings: ${result.make.warnings.join(' | ') || '—'}`);
  console.log(`notes:    ${result.make.notes}`);

  console.log('\n--- Первые 5 позиций ---');
  reviewed.slice(0, 5).forEach((it, idx) => {
    console.log(
      `\n${idx + 1}. ${it.article} — ${it.text_translated}\n` +
        `   qty=${it.quantity} gross=${it.gross_kg}kg net=${it.net_kg}kg\n` +
        `   TN VED: ${it.tnved_code} — ${it.tnved_description}\n` +
        `   duty=${it.duty_rate}% confidence=${it.confidence}%${it.needs_review ? ' ⚠️ нужна проверка' : ''}\n` +
        `   cost=$${it.cost_usd} duty=$${it.duty_usd} vat=$${it.vat_usd}\n` +
        `   reasoning: ${it.reasoning}` +
        (it.review_reason ? `\n   reviewer: ${it.review_reason}` : ''),
    );
  });

  // Sanity checks
  const sanitaryGroups = ['6910', '7307', '7324', '7412', '8481'];
  const hasSanitary = reviewed.some((it) =>
    sanitaryGroups.some((g) => it.tnved_code.startsWith(g)),
  );
  const hasFurniture = reviewed.some(
    (it) => it.tnved_code.startsWith('94') || it.tnved_code.startsWith('6907'),
  );

  console.log('\n=== Sanity ===');
  console.log(`Has sanitary codes (69xx/73xx/74xx/8481): ${hasSanitary ? '⚠️' : '✅'}`);
  console.log(`Has furniture codes (94xx) or tile (6907): ${hasFurniture ? '✅' : '⚠️'}`);

  // Group breakdown
  const groups = new Map<string, number>();
  for (const it of reviewed) {
    const g = it.tnved_code.slice(0, 4);
    groups.set(g, (groups.get(g) ?? 0) + 1);
  }
  console.log('\nГруппы ТН ВЭД:');
  [...groups.entries()]
    .sort((a, b) => b[1] - a[1])
    .forEach(([g, n]) => console.log(`  ${g}xxxx: ${n}`));
}

main().catch((e) => {
  console.error('Pipeline failed:', e);
  process.exit(1);
});
