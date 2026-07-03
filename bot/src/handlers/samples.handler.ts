import { Composer, InlineKeyboard } from 'grammy';
import AdmZip from 'adm-zip';
import type { BotContext } from '../types/context.js';
import {
  getPrecedentStats,
  upsertPrecedentsBatch,
} from '../services/tnved-precedents.repo.js';
import { fetchTelegramFile } from '../services/file-fetcher.js';
import { parseXlsxBuffer, type ParsedPackingList } from '../services/xlsx-parser.js';
import { api } from '../services/api.js';
import { logger } from '../utils/logger.js';

// =============================================================================
// «📚 Образцы кодов» — broker-curated precedent library.
//
// Populated ONLY via manual upload here. Nothing else writes to it: approved
// invoices are NOT auto-added, because brokers occasionally approve invoices
// with a wrong code and those mistakes must not turn into "rules".
//
// Accepted formats:
//   .xlsx  — single invoice: parsed, all rows added as precedents.
//   .zip   — folder of invoices: every xlsx inside is parsed and merged.
//            A ZIP with hundreds of files is the primary bulk-import path.
//
// UX is forgiving about order:
//   Tap 📚 Образцы → 📥 Загрузить → pick client → send file(s).
//   OR: send file(s) first — bot parses, then asks which client.
// Same session accepts many files in a row without re-tapping.
// =============================================================================

export const samples = new Composer<BotContext>();

interface PendingBatch {
  rows: CodeNamePair[];
  fileNames: string[];
}

interface ArmedState {
  armedAt: number;
  clientName?: string;
  // Rows parsed from files sent BEFORE the user picked a client. Held until
  // client is picked, then flushed and cleared.
  pending?: PendingBatch;
}

const armed = new Map<number, ArmedState>();
const ARM_TTL_MS = 15 * 60 * 1000;

function touch(userId: number, patch: Partial<ArmedState>): ArmedState {
  const cur = armed.get(userId);
  const next: ArmedState = {
    armedAt: Date.now(),
    clientName: cur?.clientName,
    pending: cur?.pending,
    ...patch,
  };
  armed.set(userId, next);
  return next;
}

function getArmed(userId: number): ArmedState | null {
  const s = armed.get(userId);
  if (!s) return null;
  if (Date.now() - s.armedAt > ARM_TTL_MS) {
    armed.delete(userId);
    return null;
  }
  return s;
}

async function showSamplesMenu(ctx: BotContext): Promise<void> {
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
    'Как работает база:\n' +
    '• Ты загружаешь СЮДА готовые, лично проверенные инвойсы: xlsx или zip с папкой xlsx.\n' +
    '• Бот берёт все пары (товар → код) как эталон.\n' +
    '• На следующих инвойсах: если товар совпадает или похож — код ставится из эталона и <b>подсвечивается зелёным</b>.\n\n' +
    '⚠️ Одобрённые ботом инвойсы <b>НЕ попадают</b> в базу автоматически — только то, что ты залил вручную.';

  const kb = new InlineKeyboard().text('📥 Загрузить образец', 'samples:upload').row();
  await ctx.reply(text, { parse_mode: 'HTML', reply_markup: kb });
}

samples.callbackQuery('menu:samples', async (ctx) => {
  await ctx.answerCallbackQuery();
  await showSamplesMenu(ctx);
});
samples.command('samples', async (ctx) => {
  await showSamplesMenu(ctx);
});

// Show the client picker. Called both from the initial "📥 Загрузить" tap
// AND after a file was sent before a client was picked.
async function askForClient(ctx: BotContext, prefix: string): Promise<void> {
  let clients: string[] = [];
  try {
    clients = await api.listClients();
  } catch (err) {
    logger.warn({ err }, 'listClients failed in samples flow');
  }
  if (clients.length === 0) {
    await ctx.reply('⚠️ Список клиентов пуст. Добавь клиента через /clients.');
    return;
  }
  const kb = new InlineKeyboard();
  for (const c of clients) kb.text(c, `samples:client:${encodeURIComponent(c)}`).row();
  kb.text('❌ Отмена', 'samples:cancel');
  await ctx.reply(`${prefix}\n\n👥 <b>Выбери клиента:</b>`, {
    parse_mode: 'HTML',
    reply_markup: kb,
  });
}

// Step 1: arm the session (no client yet) and show the picker.
samples.callbackQuery('samples:upload', async (ctx) => {
  await ctx.answerCallbackQuery();
  const from = ctx.from?.id;
  if (!from) return;
  touch(from, { armedAt: Date.now() });
  await askForClient(
    ctx,
    '📥 <b>Загрузка образцов</b>\n\n' +
      'После выбора клиента можно слать по одному xlsx <b>или сразу zip-архив с папкой инвойсов</b> — бот разберёт все файлы внутри.',
  );
});

// Step 2: client picked. If we already have pending rows from an early upload,
// flush them; otherwise just wait for files.
samples.callbackQuery(/^samples:client:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const from = ctx.from?.id;
  if (!from) return;
  const clientName = decodeURIComponent(ctx.match[1] ?? '');
  if (!clientName) {
    await ctx.reply('Не удалось разобрать имя клиента.');
    return;
  }

  const state = armed.get(from);
  const pending = state?.pending;

  if (pending && pending.rows.length > 0) {
    // Flush the buffered rows for the picked client.
    await ctx.reply(
      `💾 Сохраняю ${pending.rows.length} позиций из ${pending.fileNames.length} файлов для клиента <b>${clientName}</b>...`,
      { parse_mode: 'HTML' },
    );
    try {
      const batch = pending.rows.map((r) => ({
        client_name: clientName,
        product_name: r.name,
        tnved_code: r.code,
        tnved_description: r.description ?? null,
        approved_by: ctx.dbUser?.id ?? null,
        source: 'manual' as const,
      }));
      const stats = await upsertPrecedentsBatch(batch);
      touch(from, { clientName, pending: undefined });
      await ctx.reply(
        `✅ <b>${clientName}</b>: добавлено ${stats.saved} образцов${stats.failed ? `, ошибок ${stats.failed}` : ''}.\n\n` +
          'Можешь прислать следующий файл/архив или /cancel.',
        { parse_mode: 'HTML' },
      );
    } catch (err) {
      logger.warn({ err, clientName }, 'flush of pending precedents failed');
      await ctx.reply(`❌ Ошибка сохранения: ${(err as Error).message}`);
    }
    return;
  }

  touch(from, { clientName, pending: undefined });
  await ctx.reply(
    `📥 <b>Клиент: ${clientName}</b>\n\n` +
      'Присылай xlsx или zip. Можно один за другим — все пойдут этому клиенту.\n\n' +
      'Отмена: /cancel',
    { parse_mode: 'HTML' },
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

// Intercept document uploads only while the samples flow is armed. Non-armed
// documents pass through so the regular /new invoice flow keeps working.
samples.on('message:document', async (ctx, next) => {
  const from = ctx.from?.id;
  const state = from ? getArmed(from) : null;
  if (!from || !state) return next();

  const doc = ctx.message.document;
  const name = doc.file_name ?? '';
  const lower = name.toLowerCase();
  const isXlsx = lower.endsWith('.xlsx');
  const isZip = lower.endsWith('.zip');
  if (!isXlsx && !isZip) {
    await ctx.reply(`Ожидаю xlsx или zip. Получен: ${name || 'файл без имени'}. Отменено.`);
    armed.delete(from);
    return;
  }

  const target = state.clientName ? `для клиента ${state.clientName}` : '';
  await ctx.reply(`🔍 Разбираю «${name}» ${target}...`.trim());
  let parsedRows: CodeNamePair[] = [];
  const fileNames: string[] = [];
  try {
    const buf = await fetchTelegramFile(doc.file_id);
    if (isXlsx) {
      const parsed = await parseXlsxBuffer(buf, name);
      parsedRows = extractCodeNamePairs(parsed);
      fileNames.push(name);
    } else {
      // ZIP: iterate entries, parse each *.xlsx we find.
      const zip = new AdmZip(buf);
      const entries = zip.getEntries().filter((e) => {
        const en = e.entryName.toLowerCase();
        return !e.isDirectory && en.endsWith('.xlsx') && !en.includes('__macosx');
      });
      if (entries.length === 0) {
        await ctx.reply('⚠️ В архиве нет xlsx-файлов.');
        return;
      }
      await ctx.reply(`📦 В архиве нашёл ${entries.length} xlsx. Обрабатываю...`);
      let filesOk = 0;
      let filesFail = 0;
      for (const e of entries) {
        try {
          const inner = e.getData();
          const parsed = await parseXlsxBuffer(inner, e.entryName);
          const rows = extractCodeNamePairs(parsed);
          parsedRows.push(...rows);
          fileNames.push(e.entryName);
          filesOk += 1;
        } catch (err) {
          filesFail += 1;
          logger.warn({ err, entry: e.entryName }, 'zip entry failed to parse');
        }
      }
      await ctx.reply(
        `📦 Разобрано: ${filesOk} файлов, пропущено ${filesFail}. Всего позиций: ${parsedRows.length}.`,
      );
    }

    if (parsedRows.length === 0) {
      await ctx.reply(
        '⚠️ В файле(ах) не нашлось строк с 10-значными кодами ТН ВЭД и наименованиями. Проверь формат — колонка "Код ТН ВЭД" должна содержать 10-значные числа.',
      );
      return;
    }

    // If we don't yet know the client, buffer the rows and ask.
    if (!state.clientName) {
      touch(from, {
        pending: {
          rows: [...(state.pending?.rows ?? []), ...parsedRows],
          fileNames: [...(state.pending?.fileNames ?? []), ...fileNames],
        },
      });
      await askForClient(
        ctx,
        `📄 Найдено ${parsedRows.length} позиций в ${fileNames.length} файлах. Осталось указать клиента — они пойдут в его базу образцов.`,
      );
      return;
    }

    // Client known — save directly.
    const batch = parsedRows.map((r) => ({
      client_name: state.clientName as string,
      product_name: r.name,
      tnved_code: r.code,
      tnved_description: r.description ?? null,
      approved_by: ctx.dbUser?.id ?? null,
      source: 'manual' as const,
    }));
    const stats = await upsertPrecedentsBatch(batch);
    touch(from, {});
    await ctx.reply(
      `✅ <b>${state.clientName}</b>: добавлено ${stats.saved} образцов${stats.failed ? `, ошибок ${stats.failed}` : ''}.\n\n` +
        'Можешь прислать следующий файл или /cancel.',
      { parse_mode: 'HTML' },
    );
  } catch (err) {
    logger.warn({ err, file: name }, 'samples upload failed');
    await ctx.reply(`❌ Ошибка обработки: ${(err as Error).message}`);
  }
});

interface CodeNamePair {
  code: string;
  name: string;
  description?: string;
}

// Extract (code, name, description) tuples from an xlsx. Recognises the bot's
// own invoice layout (B=name, C=code) via header-row scan for "Код ТН ВЭД" and
// "Наименование" columns; falls back to fixed columns if no header found.
function extractCodeNamePairs(parsed: ParsedPackingList): CodeNamePair[] {
  const grid: string[][] = (parsed.rows ?? []).map((r) => r.cells ?? []);
  if (grid.length === 0) return [];

  let headerIdx = -1;
  let codeCol = -1;
  let nameCol = -1;
  let descCol = -1;
  for (let i = 0; i < Math.min(grid.length, 30); i++) {
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
  if (headerIdx < 0) {
    // Bot's own template: header row ~15, name in B (col 1), code in C (col 2).
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
