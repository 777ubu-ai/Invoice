import { Composer, InlineKeyboard } from 'grammy';
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
// «📚 Образцы кодов» — the precedent library UI.
//
// Precedents (broker-verified product → code pairs) come ONLY through this
// manual upload flow — never auto-saved on invoice approval. Brokers curate
// a folder of hand-checked invoices and drop them here whenever they add new
// verified samples. The classifier reads from this base on every new invoice.
//
// Flow:
//   1. User taps 📚 Образцы   → stats + "загрузить" button
//   2. User taps 📥 Загрузить  → pick client (LINEA TRANSIT / …)
//   3. User taps client        → session armed for that client
//   4. User sends xlsx         → parse + bulk insert precedents for that client
// =============================================================================

export const samples = new Composer<BotContext>();

// Per-user in-memory arm state. Simple Map is fine: small-team bot, doesn't
// need to survive a restart — user can just start the flow again.
interface ArmedState {
  armedAt: number;
  clientName: string;
}
const armed = new Map<number, ArmedState>();
const ARM_TTL_MS = 10 * 60 * 1000;

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
    '• Ты загружаешь СЮДА готовые, лично проверенные инвойсы (xlsx).\n' +
    '• Бот берёт все пары (товар → код) как эталон.\n' +
    '• На следующих инвойсах: если товар совпадает или похож — код ставится из эталона и <b>подсвечивается зелёным</b>.\n\n' +
    '⚠️ Одобрённые ботом инвойсы <b>НЕ попадают</b> в базу автоматически — только то, что ты залил вручную.';

  const kb = new InlineKeyboard()
    .text('📥 Загрузить образец', 'samples:upload')
    .row();

  await ctx.reply(text, { parse_mode: 'HTML', reply_markup: kb });
}

samples.callbackQuery('menu:samples', async (ctx) => {
  await ctx.answerCallbackQuery();
  await showSamplesMenu(ctx);
});

samples.command('samples', async (ctx) => {
  await showSamplesMenu(ctx);
});

// Step 1 of upload: ask which client the samples are for.
samples.callbackQuery('samples:upload', async (ctx) => {
  await ctx.answerCallbackQuery();
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
  for (const c of clients) {
    kb.text(c, `samples:client:${encodeURIComponent(c)}`).row();
  }
  kb.text('❌ Отмена', 'samples:cancel');
  await ctx.reply(
    '👥 <b>Для какого клиента загружаешь образец?</b>\n\n' +
      'Выбранный клиент определит область применения: точно такие же товары этого клиента на следующих инвойсах будут распознаны как «проверенные».',
    { parse_mode: 'HTML', reply_markup: kb },
  );
});

// Step 2 of upload: arm the session for the chosen client and wait for xlsx.
samples.callbackQuery(/^samples:client:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const from = ctx.from?.id;
  if (!from) return;
  const clientName = decodeURIComponent(ctx.match[1] ?? '');
  if (!clientName) {
    await ctx.reply('Не удалось разобрать имя клиента.');
    return;
  }
  armed.set(from, { armedAt: Date.now(), clientName });
  await ctx.reply(
    `📥 <b>Клиент: ${clientName}</b>\n\n` +
      'Теперь отправь мне xlsx-файл проверенного инвойса. Я разберу все позиции и добавлю их в базу образцов этого клиента.\n\n' +
      'Можно отправить несколько файлов подряд — все пойдут этому же клиенту.\n\n' +
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

// Intercept document uploads only while the samples flow is armed for a
// specific client. If not armed, do nothing — the regular /new invoice flow
// keeps handling document messages.
samples.on('message:document', async (ctx, next) => {
  const from = ctx.from?.id;
  const state = from ? getArmed(from) : null;
  if (!from || !state) return next();

  const doc = ctx.message.document;
  const name = doc.file_name ?? '';
  if (!name.toLowerCase().endsWith('.xlsx')) {
    await ctx.reply(`Ожидаю xlsx. Получен: ${name || 'файл без имени'}. Отменено.`);
    armed.delete(from);
    return;
  }

  await ctx.reply(`🔍 Разбираю «${name}» для клиента ${state.clientName}...`);
  try {
    const buf = await fetchTelegramFile(doc.file_id);
    const parsed = await parseXlsxBuffer(buf, name);
    const rows = extractCodeNamePairs(parsed);
    if (rows.length === 0) {
      await ctx.reply(
        '⚠️ В файле не нашлось строк с 10-значными кодами и наименованиями. Убедись что колонка «КОД ТН ВЭД» содержит десятизначные числа.',
      );
      return;
    }
    const batch = rows.map((r) => ({
      client_name: state.clientName,
      product_name: r.name,
      tnved_code: r.code,
      tnved_description: r.description ?? null,
      approved_by: ctx.dbUser?.id ?? null,
      source: 'manual' as const,
    }));
    const stats = await upsertPrecedentsBatch(batch);
    // Reset the timer so the user can send more files without re-tapping.
    armed.set(from, { armedAt: Date.now(), clientName: state.clientName });
    await ctx.reply(
      `✅ <b>${state.clientName}</b>: добавлено ${stats.saved} образцов${stats.failed ? `, ошибок ${stats.failed}` : ''}.\n\n` +
        'Можешь прислать следующий файл или нажать /cancel чтобы выйти.',
      { parse_mode: 'HTML' },
    );
  } catch (err) {
    logger.warn({ err, file: name }, 'samples upload failed');
    await ctx.reply(`❌ Ошибка загрузки: ${(err as Error).message}`);
  }
});

interface CodeNamePair {
  code: string;
  name: string;
  description?: string;
}

// Extract (code, name, description) tuples from an xlsx. Recognises the bot's
// own invoice layout (B=name, C=code) via a header-row scan for «Код ТН ВЭД»
// and «Наименование» columns; falls back to fixed columns if no header found.
function extractCodeNamePairs(parsed: ParsedPackingList): CodeNamePair[] {
  const grid: string[][] = (parsed.rows ?? []).map((r) => r.cells ?? []);
  if (grid.length === 0) return [];

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
