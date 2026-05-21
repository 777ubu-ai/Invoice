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

  console.log('\n=== Running 3-agent pipeline ===');
  const fileText = rowsAsText(parsed);
  const reviewed = await runClassificationPipeline(fileText, (p) => {
    console.log(`[stage ${p.stage}] ${p.label}`);
  });

  console.log(`\n=== Pipeline returned ${reviewed.length} items ===`);
  reviewed.slice(0, 10).forEach((it, idx) => {
    console.log(
      `\n${idx + 1}. ${it.article} — ${it.text_translated}\n` +
        `   qty=${it.quantity} gross=${it.gross_kg}kg net=${it.net_kg}kg\n` +
        `   TN VED: ${it.tnved_code} — ${it.tnved_description}\n` +
        `   duty=${it.duty_rate}% confidence=${it.confidence}%${it.needs_review ? ' ⚠️ нужна проверка' : ''}\n` +
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
