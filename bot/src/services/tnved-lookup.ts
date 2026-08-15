import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { logger } from '../utils/logger.js';

// =============================================================================
// ТН ВЭД ЕАЭС — локальный справочник 10-значных кодов с описаниями.
//
// База — bot/data/tnved-eaeu.csv (≈12 500 десятизначных кодов).
// Источник: github.com/infoculture/opencustoms (открытые данные ФТС РФ).
//
// Используется как ground-truth валидатор: после агента-классификатора
// каждый код проверяется на существование. Несуществующие коды отправляются
// классификатору на переподбор с явным списком допустимых сестринских кодов.
// =============================================================================

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// CSV lives at bot/data/tnved-eaeu.csv. The relative position differs between
// dev (src/services/...) and the compiled image (dist/src/services/...), so we
// probe a small set of candidates and use the first one that exists.
const CSV_CANDIDATES = [
  join(__dirname, '../../data/tnved-eaeu.csv'),     // dev: src/services -> bot/data
  join(__dirname, '../../../data/tnved-eaeu.csv'),  // prod: dist/src/services -> /app/data
  join(process.cwd(), 'data/tnved-eaeu.csv'),       // fallback: explicit cwd
  join(process.cwd(), 'bot/data/tnved-eaeu.csv'),   // fallback: monorepo root cwd
];

function resolveCsvPath(): string {
  for (const p of CSV_CANDIDATES) {
    if (existsSync(p)) return p;
  }
  throw new Error(
    `ТН ВЭД-справочник не найден ни по одному из путей: ${CSV_CANDIDATES.join(', ')}`,
  );
}

export interface TnvedEntry {
  code: string;
  description: string;
}

let byCode: Map<string, string> | null = null;
let bySixDigit: Map<string, TnvedEntry[]> | null = null;
let byFourDigit: Map<string, TnvedEntry[]> | null = null;
// Set to true after loadDb() throws — subsequent calls degrade to pass-through
// (no validation) instead of crashing the bot. The pipeline behaves like it did
// before the validator was added.
let dbUnavailable = false;

function parseCsvLine(line: string): [string, string] | null {
  // Format: <digits>,<description-or-quoted-description>
  const m = line.match(/^(\d+),(?:"((?:[^"]|"")*)"|([^,]*))/);
  if (!m) return null;
  const code: string = m[1] ?? '';
  if (!code) return null;
  const desc: string = (m[2] ?? m[3] ?? '').replace(/""/g, '"').trim();
  return [code, desc];
}

function loadDb(): {
  byCode: Map<string, string>;
  bySix: Map<string, TnvedEntry[]>;
  byFour: Map<string, TnvedEntry[]>;
} | null {
  if (dbUnavailable) return null;
  if (byCode && bySixDigit && byFourDigit) {
    return { byCode, bySix: bySixDigit, byFour: byFourDigit };
  }
  const t0 = Date.now();
  let csvPath: string;
  let text: string;
  try {
    csvPath = resolveCsvPath();
    text = readFileSync(csvPath, 'utf8');
  } catch (err) {
    dbUnavailable = true;
    logger.error(
      { err, candidates: CSV_CANDIDATES },
      'tnved-lookup DB unavailable — validator will pass through codes without checking',
    );
    return null;
  }
  const codes = new Map<string, string>();
  const sixGroups = new Map<string, TnvedEntry[]>();
  const fourGroups = new Map<string, TnvedEntry[]>();

  for (const line of text.split('\n')) {
    const parsed = parseCsvLine(line);
    if (!parsed) continue;
    const [code, description] = parsed;
    if (code.length !== 10) continue;
    codes.set(code, description);
    const sixKey = code.slice(0, 6);
    const fourKey = code.slice(0, 4);
    const entry: TnvedEntry = { code, description };
    if (!sixGroups.has(sixKey)) sixGroups.set(sixKey, []);
    sixGroups.get(sixKey)!.push(entry);
    if (!fourGroups.has(fourKey)) fourGroups.set(fourKey, []);
    fourGroups.get(fourKey)!.push(entry);
  }

  byCode = codes;
  bySixDigit = sixGroups;
  byFourDigit = fourGroups;
  logger.info(
    {
      path: csvPath,
      codes: codes.size,
      six_groups: sixGroups.size,
      four_groups: fourGroups.size,
      ms: Date.now() - t0,
    },
    'tnved-lookup database loaded',
  );
  return { byCode: codes, bySix: sixGroups, byFour: fourGroups };
}

export interface ValidationResult {
  valid: boolean;
  code: string;
  official_description?: string;
  siblings_six?: TnvedEntry[];
  siblings_four?: TnvedEntry[];
}

export function validateCode(rawCode: string): ValidationResult {
  const code = String(rawCode ?? '').trim();
  if (!/^\d{10}$/.test(code)) {
    return { valid: false, code };
  }
  const db = loadDb();
  // DB missing — degrade to pass-through so the bot keeps running.
  if (!db) return { valid: true, code };
  const desc = db.byCode.get(code);
  if (desc) {
    return { valid: true, code, official_description: desc };
  }
  return {
    valid: false,
    code,
    siblings_six: db.bySix.get(code.slice(0, 6)) ?? [],
    siblings_four: db.byFour.get(code.slice(0, 4)) ?? [],
  };
}

export function lookupDescription(code: string): string | null {
  return loadDb()?.byCode.get(code) ?? null;
}

// Eagerly initialize on import so the first invoice request doesn't pay the
// cost. Never throws — a missing catalogue only prints an error and disables
// validation for the process lifetime.
export function preloadDatabase(): void {
  loadDb();
}
