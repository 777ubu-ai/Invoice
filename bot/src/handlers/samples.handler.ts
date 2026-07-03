import { Composer, InlineKeyboard } from 'grammy';
import type { BotContext } from '../types/context.js';
import {
  getPrecedentStats,
  upsertPrecedentsBatch,
} from '../services/tnved-precedents.repo.js';
import { fetchTelegramFile } from '../services/file-fetcher.js';
import { parseXlsxBuffer, type ParsedPackingList } from '../services/xlsx-parser.js';
import { logger } from '../utils/logger.js';

// =============================================================================
// «📚 Образцы кодов» — the precedent library UI.
//
//   /samples or menu:samples → main screen with stats and actions
//   samples:upload           → arm session to accept the next xlsx as bulk import
//   samples:cancel           → drop the armed state
//
// Bulk import strategy: user sends an already-approved invoice xlsx (like a
// previous 2026-C351-XXXX.xlsx). The parser finds the code column and product
// name column and inserts a precedent for each row. Wrong-format uploads are
// rejected with a clear message.
// =============================================================================

export const samples = new Composer<BotContext>();

// Per-user in-memory arm state. Simple Map is fine: we're a small-team bot and
// the state doesn't need to survive a restart — user can just tap the button
// again. Keyed by telegram user id.
const armed = new Map<number, { armedAt: number; clientName?: string }>();
const ARM_TTL_MS = 5 * 60 * 1000;

function isArmed(userId: number): boolean {
  const s = armed.get(userId);
  if (!s) return false;
  if (Date.now() - s.armedAt > ARM_TTL_MS) {
    armed.delete(userId);
    return false;
  }
  return true;
}

async function showSamplesMenu(ctx: BotContext): Promise<void> {
  // For now the OWNER sees an aggregated global view. Per-client filter can
  // come later; the DB schema already supports it.
  const stats = await getPrecedentStats(null).catch((err) => {
    logger.warn({ err }, 'getPrecedentStats failed');
    return { total: 0, distinct_codes: 0, top_codes: [] };
  });

  const topLines = stats.top_codes.length
    ? stats.top_codes
        .slice(0, 5)
        .map(
          (t) =>
            `• ${t.code} — ${t.usage_count}× ${t.description ? `— ${t.description.slice(0, 60)}` : ''}`,
        )
        .join('\n')
    : '(база образцов пока пустая)';

  const text =
    '📚 <b>Образцы кодов ТН ВЭД</b>\n\n' +
    `Всего образцов: <b>${stats.total}</b>\n` +
    `Разных кодов: <b>${stats.distinct_codes}</b>\n\n` +
    '<b>Топ-5 наиболее применяемых:</b>\n' +
    topLines +
    '\n\n' +
    'Каждый одобренный инвойс автоматически добавляется в эту базу — на следующем инвойсе повторяющиеся товары уже будут распознаваться как «проверенные».\n\n' +
    'Можно также загрузить старый инвойс вручную — все его позиции сразу пойдут в базу образцов.';

  const kb = new InlineKeyboard()
    .text('📥 Загрузить готовый инвойс', 'samples:upload')
    .row()
    .text('◀️ Назад', 'menu:back');

  await ctx.reply(text, { parse_mode: 'HTML', reply_markup: kb });
}

samples.callbackQuery('menu:samples', async (ctx) => {
  await ctx.answerCallbackQuery();
  await showSamplesMenu(ctx);
});

samples.command('samples', async (ctx) => {
  await showSamplesMenu(ctx);
});

samples.callbackQuery('samples:upload', async (ctx) => {
  await ctx.answerCallbackQuery();
  const from = ctx.from?.id;
  if (!from) return;
  armed.set(from, { armedAt: Date.now() });
  await ctx.reply(
    '📥 Загрузка образцов\n\n' +
      'Отправь мне xlsx-файл готового ранее одобренного инвойса — например `invoice_2026-C351-0129.xlsx`. ' +
      'Я разберу его и добавлю все позиции в базу образцов.\n\n' +
      'Отменить: /cancel',
  );
});

samples.callbackQuery('samples:cancel', async (ctx) => {
  await ctx.answerCallbackQuery();
  if (ctx.from?.id) armed.delete(ctx.from.id);
  await ctx.reply('Отменено.');
});

samples.command('cancel', async (ctx) => {
  if (ctx.from?.id) armed.delete(ctx.from.id);
  await ctx.reply('Отменено.');
});

// Intercept document uploads only when the user has armed the samples flow.
// If not armed, we do nothing — the regular /new invoice flow keeps handling
// document messages.
samples.on('message:document', async (ctx, next) => {
  const from = ctx.from?.id;
  if (!from || !isArmed(from)) return next();

  const doc = ctx.message.document;
  const name = doc.file_name ?? '';
  if (!name.toLowerCase().endsWith('.xlsx')) {
    await ctx.reply(`Ожидаю xlsx. Получен: ${name || 'файл без имени'}. Отменено.`);
    armed.delete(from);
    return;
  }

  await ctx.reply('🔍 Разбираю файл...');
  try {
    const buf = await fetchTelegramFile(doc.file_id);
    const parsed = await parseXlsxBuffer(buf, name);
    // Heuristic: find header row that has a "код" column and a "наименование"
    // column. Bot's own invoice format uses columns B (name) and C (code).
    const rows = extractCodeNamePairs(parsed);
    if (rows.length === 0) {
      await ctx.reply(
        '⚠️ В файле не нашлось строк с 10-значными кодами и наименованиями. Убедись что колонка "КОД ТН ВЭД" содержит десятизначные числа.',
      );
      armed.delete(from);
      return;
    }
    // The uploaded file might mix several clients — we can't know reliably.
    // Store all under a shared "MANUAL_UPLOAD" bucket so they can still be
    // pruned later; the real client-scoped save path is the auto-save on
    // Approve. If the user hints at a client name via a caption, use it.
    const clientName = (ctx.message.caption ?? '').trim() || 'MANUAL_UPLOAD';
    const batch = rows.map((r) => ({
      client_name: clientName,
      product_name: r.name,
      tnved_code: r.code,
      tnved_description: r.description ?? null,
      approved_by: ctx.dbUser?.id ?? null,
      source: 'manual' as const,
    }));
    const stats = await upsertPrecedentsBatch(batch);
    armed.delete(from);
    await ctx.reply(
      `✅ Загружено ${stats.saved} образцов${stats.failed ? `, ошибок: ${stats.failed}` : ''}.\n` +
        `Клиент: <b>${clientName}</b>${clientName === 'MANUAL_UPLOAD' ? ' (укажи имя клиента в подписи к файлу в следующий раз)' : ''}`,
      { parse_mode: 'HTML' },
    );
  } catch (err) {
    logger.warn({ err, file: name }, 'samples upload failed');
    armed.delete(from);
    await ctx.reply(`❌ Ошибка загрузки: ${(err as Error).message}`);
  }
});

interface CodeNamePair {
  code: string;
  name: string;
  description?: string;
}

// Extract (code, name, description) tuples from an xlsx that follows our own
// invoice template: header row somewhere in R1..R20, then item rows below.
// Skip totals and blanks. Recognises either aggregated (B=name, C=code) layout
// or generic tables with any column named "код"/"code".
function extractCodeNamePairs(parsed: ParsedPackingList): CodeNamePair[] {
  // Flatten RawRow[] to plain string[][] for column-based scanning.
  const grid: string[][] = (parsed.rows ?? []).map((r) => r.cells ?? []);
  if (grid.length === 0) return [];

  // Find header row: contains "код" and any name-ish column ("наименование" / "товар" / "product").
  let headerIdx = -1;
  let codeCol = -1;
  let nameCol = -1;
  let descCol = -1;
  for (let i = 0; i < Math.min(grid.length, 25); i++) {
    const row = (grid[i] ?? []).map((c) => String(c ?? '').toLowerCase());
    const codeI = row.findIndex((c) => /код\s*тн\s*вэд|код\s*тнвэд|^код$|^code$/.test(c));
    const nameI = row.findIndex((c) => /наимен|товар|product|name/.test(c));
    if (codeI >= 0 && nameI >= 0) {
      headerIdx = i;
      codeCol = codeI;
      nameCol = nameI;
      descCol = row.findIndex((c) => /описан|group|катего/.test(c));
      break;
    }
  }
  // Fallback: assume the bot's own layout (row 15, B=name, C=code).
  if (headerIdx < 0) {
    headerIdx = 14;
    nameCol = 1;
    codeCol = 2;
  }

  const out: CodeNamePair[] = [];
  const seen = new Set<string>();
  for (let i = headerIdx + 1; i < grid.length; i++) {
    const row = grid[i] ?? [];
    const rawCode = String(row[codeCol] ?? '').replace(/[^\d]/g, '');
    const name = String(row[nameCol] ?? '').trim();
    if (!/^\d{10}$/.test(rawCode)) continue;
    if (!name || name.toLowerCase().startsWith('итого')) continue;
    const key = `${rawCode}::${name.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const desc = descCol >= 0 ? String(row[descCol] ?? '').trim() : undefined;
    out.push({ code: rawCode, name, description: desc || undefined });
  }
  return out;
}

// Fallback: user tapped "Назад" from the samples screen. Show the main menu.
samples.callbackQuery('menu:back', async (ctx) => {
  await ctx.answerCallbackQuery();
  // Delegate to the existing /start-style menu display.
  await ctx.reply('Главное меню — используй /start');
});
