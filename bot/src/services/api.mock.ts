import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ExcelJS from 'exceljs';
import { supabase } from './supabase.js';
import { logger } from '../utils/logger.js';
import { runClassificationPipeline, isClaudeEnabled } from './classifier.js';
import { fetchTelegramFile } from './file-fetcher.js';
import { parseXlsxBuffer, rowsAsText } from './xlsx-parser.js';
import type {
  ApiClient,
  ApproveResult,
  InvoiceItem,
  InvoiceState,
  InvoiceStatus,
  InvoiceSummary,
  PriceMode,
  TnvedHit,
  UploadInput,
  UploadResult,
} from './api.types.js';

const CLASSIFICATION_DELAY_MS = 8_000;

const CLIENTS = ['LINEA TRANSIT', 'ТОО Альфа'];

const TNVED_CATALOG: TnvedHit[] = [
  { code: '7412200000', description: 'Фитинги для труб из медных сплавов', duty_rate: 3 },
  { code: '7415310000', description: 'Гайки, шурупы из меди', duty_rate: 5 },
  { code: '8481808199', description: 'Краны латунные', duty_rate: 5 },
  { code: '3917400000', description: 'Фитинги пластиковые', duty_rate: 6.5 },
  { code: '7307990000', description: 'Прочие фитинги из чёрных металлов', duty_rate: 5 },
  { code: '6910100000', description: 'Сантехника фарфоровая', duty_rate: 12 },
  { code: '7324900000', description: 'Сантехника из чёрных металлов', duty_rate: 10 },
];


// Decode a stored source_file_url of the form "tg:<file_id>?name=<encoded>".
function parseSourceFileUrl(
  url: string | null | undefined,
): { fileId: string; fileName: string } | null {
  if (!url || !url.startsWith('tg:')) return null;
  const rest = url.slice('tg:'.length);
  const qIdx = rest.indexOf('?');
  const fileId = qIdx >= 0 ? rest.slice(0, qIdx) : rest;
  let fileName = '';
  if (qIdx >= 0) {
    const params = new URLSearchParams(rest.slice(qIdx + 1));
    fileName = params.get('name') ?? '';
  }
  return { fileId, fileName };
}

// Download the uploaded packing list, parse xlsx, run the full 5-agent pipeline
// (Переводчик → Классификатор → Ревьюер → Лаура → Маке).
// Throws (with a Russian error message) on any failure — no silent fallback.
async function classifyFromUploadedFile(
  fileRef: string,
  clientName: string,
  mode: PriceMode,
  value: number | undefined,
): Promise<{ items: InvoiceItem[]; summary: InvoiceSummary }> {
  const parsed = parseSourceFileUrl(fileRef);
  if (!parsed) {
    throw new Error('Не удалось разобрать ссылку на файл. Попробуй заново.');
  }
  const { fileId, fileName } = parsed;
  if (!fileName.toLowerCase().endsWith('.xlsx')) {
    throw new Error(
      `Поддерживается только формат xlsx. Получен: ${fileName || 'неизвестно'}. ` +
        `PDF и фото будут поддержаны позже.`,
    );
  }

  const buf = await fetchTelegramFile(fileId).catch((e) => {
    throw new Error(`Не удалось скачать файл из Telegram: ${(e as Error).message}`);
  });
  const parsedXlsx = await parseXlsxBuffer(buf, fileName).catch((e) => {
    throw new Error(`Не удалось распарсить xlsx: ${(e as Error).message}`);
  });
  if (parsedXlsx.totalRows === 0) {
    throw new Error('В файле нет ни одной строки с данными.');
  }
  logger.info({ fileName, rows: parsedXlsx.totalRows }, 'parsed xlsx');

  const fileText = rowsAsText(parsedXlsx);
  const result = await runClassificationPipeline(
    fileText,
    { mode, value, defaultPricePerKg: defaultPricePerKgFor(clientName) },
    (p) => {
      logger.info({ stage: p.stage, label: p.label }, 'pipeline progress');
    },
  );

  if (result.items.length === 0) {
    throw new Error('Pipeline вернул 0 позиций.');
  }

  const items: InvoiceItem[] = result.items.map((it, idx) => ({
    index: idx + 1,
    article: it.article || `ITEM-${idx + 1}`,
    text_original: it.text_original || '',
    text_translated: it.text_translated || '',
    quantity: it.quantity || 0,
    gross_kg: it.gross_kg || 0,
    net_kg: it.net_kg || Math.round((it.gross_kg || 0) * 0.95),
    tnved_code: it.tnved_code,
    tnved_description: it.tnved_description,
    duty_rate: it.duty_rate,
    confidence: it.confidence,
    needs_review: it.needs_review,
    review_reason: it.review_reason,
    reasoning: it.reasoning,
    alternatives: it.alternatives,
    cost_usd: it.cost_usd,
    duty_usd: it.duty_usd,
    vat_usd: it.vat_usd,
  }));

  const summary: InvoiceSummary = {
    items_count: items.length,
    codes_count: new Set(items.map((i) => i.tnved_code)).size,
    gross_kg: result.financials.gross_kg,
    net_kg: result.financials.net_kg,
    units_total: result.financials.units,
    cost_usd: result.financials.cost_usd,
    duty_usd: result.financials.duty_usd,
    vat_usd: result.financials.vat_usd,
    fee_usd: result.financials.fee_usd,
    total_payments_usd: result.financials.total_payments_usd,
    target_usd: result.financials.target_usd,
    laura_notes: result.laura_notes,
    make_approved: result.make.approved,
    make_warnings: result.make.warnings,
    make_notes: result.make.notes,
  };

  return { items, summary };
}

function defaultPricePerKgFor(clientName: string): number {
  if (/LINEA TRANSIT/i.test(clientName)) return 0.75;
  return 0.75;
}


async function setInvoiceFields(
  invoiceId: string,
  fields: Record<string, unknown>,
): Promise<void> {
  const { error } = await supabase
    .from('invoices')
    .update({ ...fields, updated_at: new Date().toISOString() })
    .eq('id', invoiceId);
  if (error) throw error;
}

async function getInvoiceRow(invoiceId: string): Promise<InvoiceState> {
  const { data, error } = await supabase
    .from('invoices')
    .select('*')
    .eq('id', invoiceId)
    .single();
  if (error) throw error;
  return {
    id: data.id,
    invoice_number: data.invoice_number,
    client_name: data.client_name,
    status: data.status as InvoiceStatus,
    price_mode: data.price_mode,
    price_value: data.price_value,
    summary: data.summary,
    items: data.items,
    result_file_url: data.result_file_url,
    source_file_url: data.source_file_url,
    assigned_to: data.assigned_to,
    created_by: data.created_by,
    reassigned_from: data.reassigned_from,
    created_at: data.created_at,
    updated_at: data.updated_at,
  };
}

async function generateInvoiceNumber(): Promise<string> {
  const { count } = await supabase
    .from('invoices')
    .select('id', { count: 'exact', head: true });
  const seq = String((count ?? 0) + 1).padStart(4, '0');
  return `2026-C351-${seq}`;
}

// Per-client invoice configuration. For LINEA TRANSIT the agreed price formula
// is net_kg × $0.75 — the customs declaration uses that exactly.
interface ClientProfile {
  consigneeBlock: string[]; // C4, C5
  pricePerNetKg: number; // formula multiplier
  category: string; // group label that goes in column A of the first item
}

function clientProfile(clientName: string, items: InvoiceItem[]): ClientProfile {
  if (clientName.includes('LINEA')) {
    // Infer a single category label from the most common TN VED group prefix.
    const category = inferCategoryLabel(items);
    return {
      consigneeBlock: [
        'ТОО "LINEA TRANSIT"  БИН: 2604 4003 9864',
        'РК, область Жетісу, город Талдыкорган, улица Абылай хана, дом 363',
      ],
      pricePerNetKg: 0.75,
      category,
    };
  }
  return {
    consigneeBlock: [clientName, ''],
    pricePerNetKg: 0.75,
    category: inferCategoryLabel(items),
  };
}

function inferCategoryLabel(items: InvoiceItem[]): string {
  if (items.length === 0) return 'ТОВАРЫ КИТАЙСКОГО ПРОИЗВОДСТВА';
  const counts = new Map<string, number>();
  for (const it of items) {
    const prefix = it.tnved_code.slice(0, 2);
    counts.set(prefix, (counts.get(prefix) ?? 0) + 1);
  }
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';
  const groupNames: Record<string, string> = {
    '94': 'МЕБЕЛЬ И ПРЕДМЕТЫ ИНТЕРЬЕРА',
    '64': 'ОБУВЬ',
    '61': 'ОДЕЖДА ТРИКОТАЖНАЯ',
    '62': 'ОДЕЖДА ТЕКСТИЛЬНАЯ',
    '85': 'ЭЛЕКТРОТОВАРЫ И ЭЛЕКТРОНИКА',
    '84': 'МАШИНЫ И ОБОРУДОВАНИЕ',
    '69': 'КЕРАМИКА И САНТЕХНИКА',
    '73': 'ИЗДЕЛИЯ ИЗ ЧЁРНЫХ МЕТАЛЛОВ',
    '74': 'ИЗДЕЛИЯ ИЗ МЕДИ',
    '39': 'ПЛАСТМАССОВЫЕ ИЗДЕЛИЯ',
    '95': 'ИГРУШКИ И СПОРТТОВАРЫ',
    '42': 'КОЖГАЛАНТЕРЕЯ',
  };
  return groupNames[top] ?? 'ТОВАРЫ КИТАЙСКОГО ПРОИЗВОДСТВА';
}

// Merge items into one row per ТН ВЭД code. Customs expects an aggregated table —
// one line per code with summed weight/qty, not 60+ near-identical rows.
interface MergedRow {
  tnved_code: string;
  tnved_description: string;
  name: string;
  source_count: number;
  quantity: number;
  net_kg: number;
  gross_kg: number;
  cost_usd: number;
}

function groupItemsByCode(items: InvoiceItem[]): MergedRow[] {
  const map = new Map<string, MergedRow>();
  const namesByCode = new Map<string, Set<string>>();
  for (const it of items) {
    const code = it.tnved_code;
    const cleanName = (it.text_translated || it.text_original || '').trim();
    const namesSet = namesByCode.get(code) ?? new Set<string>();
    if (cleanName) namesSet.add(cleanName.toUpperCase());
    namesByCode.set(code, namesSet);

    const existing = map.get(code);
    if (existing) {
      existing.quantity += it.quantity || 0;
      existing.net_kg += it.net_kg || 0;
      existing.gross_kg += it.gross_kg || 0;
      existing.cost_usd += it.cost_usd || 0;
      existing.source_count += 1;
    } else {
      map.set(code, {
        tnved_code: code,
        tnved_description: it.tnved_description,
        name: cleanName.toUpperCase(),
        source_count: 1,
        quantity: it.quantity || 0,
        net_kg: it.net_kg || 0,
        gross_kg: it.gross_kg || 0,
        cost_usd: it.cost_usd || 0,
      });
    }
  }
  // Use the joined set of distinct product names as the row label, capped to 3.
  for (const [code, row] of map.entries()) {
    const names = [...(namesByCode.get(code) ?? [])];
    if (names.length === 0) {
      row.name = row.tnved_description.toUpperCase();
    } else if (names.length <= 3) {
      row.name = names.join(', ');
    } else {
      row.name = `${names.slice(0, 3).join(', ')} И ДР. (${names.length} НАИМ.)`;
    }
    row.net_kg = Math.round(row.net_kg * 100) / 100;
    row.gross_kg = Math.round(row.gross_kg * 100) / 100;
    row.cost_usd = Math.round(row.cost_usd * 100) / 100;
  }
  // Sort by gross weight desc so the biggest categories come first.
  return [...map.values()].sort((a, b) => b.gross_kg - a.gross_kg);
}

async function buildXlsx(invoice: InvoiceState): Promise<string> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'TNVED.ai bot';
  const sheetName = invoice.invoice_number?.slice(-4) ?? '0001';
  const ws = wb.addWorksheet(sheetName);

  // Column widths match the LINEA TRANSIT template.
  const widths = [22, 60, 14, 10, 12, 12, 12, 14];
  widths.forEach((w, i) => {
    ws.getColumn(i + 1).width = w;
  });

  const items = invoice.items ?? [];
  const profile = clientProfile(invoice.client_name, items);

  // ---------- Header ----------
  ws.getCell('A1').value = 'ГРУЗООТПРАВИТЕЛЬ';
  ws.getCell('A1').font = { bold: true };
  ws.getCell('C1').value = 'XINJIANG TERRITORY VERTICAL ELECTRONIC COMMERCE.,LTD';
  ws.getCell('C2').value =
    'COMPANY ADDRESS: ADD: YILI PREFECTURE IN XINJIANG PROVINCE LANZHOU, HUOERGOS CITY RIVERSIDE ROADLANE 1, ROOM 201, BUILDING 1 UNIT';
  ws.getCell('C2').alignment = { wrapText: true };

  ws.getCell('A4').value = 'ГРУЗОПОЛУЧАТЕЛЬ';
  ws.getCell('A4').font = { bold: true };
  ws.getCell('C4').value = profile.consigneeBlock[0];
  ws.getCell('C5').value = profile.consigneeBlock[1];
  ws.getCell('C5').alignment = { wrapText: true };

  const today = new Date().toLocaleDateString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });
  ws.getCell('C7').value = 'ИНВОЙС - УПАКОВОЧНЫЙ ЛИСТ:';
  ws.getCell('C7').font = { bold: true };
  ws.getCell('H7').value = `№ ${invoice.invoice_number ?? ''} от ${today}г.`;
  ws.getCell('H7').font = { bold: true };

  ws.getCell('A9').value = 'МЕСТО ДОСТАВКИ ТОВАРА: QAZAQSTAN, ALMATY';
  ws.getCell('A10').value = 'УСЛОВИЕ ПОСТАВКИ: DAP NUR ZHOLY';
  ws.getCell('A11').value = 'УКАЗАННЫЕ ТОВАРЫ КИТАЙСКОГО ПРОИСХОЖДЕНИЯ';
  ws.getCell('A12').value = 'КОНТРАКТ: LT001 от 01.05.2026г.';
  ws.getCell('A13').value = 'АВТО № 229BHW02-15ALZ02';

  // ---------- Table header (row 15) ----------
  const HEADER_ROW = 15;
  const headers: Array<[string, string]> = [
    ['B', 'НАИМЕНОВАНИЕ ТОВАРА'],
    ['C', 'КОД ТН ВЭД'],
    ['D', 'КОЛИЧЕСТВО МЕСТ'],
    ['E', 'КОЛИЧЕСТВО (ШТ)'],
    ['F', 'ВЕС НЕТТО (KG)'],
    ['G', 'ВЕС БРУТТО (KG)'],
    ['H', 'СТОИМОСТЬ ($)'],
  ];
  for (const [col, label] of headers) {
    const cell = ws.getCell(`${col}${HEADER_ROW}`);
    cell.value = label;
    cell.font = { bold: true };
    cell.alignment = { wrapText: true, vertical: 'middle', horizontal: 'center' };
    cell.border = {
      top: { style: 'thin' },
      bottom: { style: 'thin' },
      left: { style: 'thin' },
      right: { style: 'thin' },
    };
  }
  ws.getRow(HEADER_ROW).height = 32;

  // ---------- Item rows (grouped by ТН ВЭД code) ----------
  // Стоимость берём из расчёта Лауры (cost_usd на каждой позиции). Пишем как
  // число с кешированным значением формулы — Telegram/preview покажут сразу.
  const groupedRows = groupItemsByCode(items);
  const START_ROW = HEADER_ROW + 1;
  groupedRows.forEach((row, idx) => {
    const r = START_ROW + idx;
    if (idx === 0) {
      ws.getCell(`A${r}`).value = profile.category;
      ws.getCell(`A${r}`).alignment = { wrapText: true, vertical: 'top' };
      ws.getCell(`A${r}`).font = { bold: true };
    }
    ws.getCell(`B${r}`).value = row.name;
    ws.getCell(`B${r}`).alignment = { wrapText: true, vertical: 'top' };
    ws.getCell(`C${r}`).value = Number(row.tnved_code);
    ws.getCell(`D${r}`).value = row.source_count;
    ws.getCell(`E${r}`).value = row.quantity;
    ws.getCell(`F${r}`).value = row.net_kg;
    ws.getCell(`G${r}`).value = row.gross_kg;
    ws.getCell(`H${r}`).value = row.cost_usd;
    ws.getCell(`H${r}`).numFmt = '#,##0.00';

    for (let c = 1; c <= 8; c++) {
      ws.getRow(r).getCell(c).border = {
        top: { style: 'thin' },
        bottom: { style: 'thin' },
        left: { style: 'thin' },
        right: { style: 'thin' },
      };
    }
  });

  // ---------- ИТОГО row + блок налогов ----------
  if (groupedRows.length > 0) {
    const lastItemRow = START_ROW + groupedRows.length - 1;
    const totalRow = lastItemRow + 2;
    const totalNet = groupedRows.reduce((s, r) => s + r.net_kg, 0);
    const totalGross = groupedRows.reduce((s, r) => s + r.gross_kg, 0);
    const totalQty = groupedRows.reduce((s, r) => s + r.quantity, 0);
    const totalPlaces = groupedRows.reduce((s, r) => s + r.source_count, 0);
    const totalCost = groupedRows.reduce((s, r) => s + r.cost_usd, 0);

    ws.getCell(`C${totalRow}`).value = 'ИТОГО:';
    ws.getCell(`D${totalRow}`).value = totalPlaces;
    ws.getCell(`E${totalRow}`).value = totalQty;
    ws.getCell(`F${totalRow}`).value = Math.round(totalNet * 100) / 100;
    ws.getCell(`G${totalRow}`).value = Math.round(totalGross * 100) / 100;
    ws.getCell(`H${totalRow}`).value = Math.round(totalCost * 100) / 100;
    ws.getCell(`H${totalRow}`).numFmt = '#,##0.00';
    for (let c = 1; c <= 8; c++) {
      ws.getRow(totalRow).getCell(c).font = { bold: true };
      ws.getRow(totalRow).getCell(c).border = {
        top: { style: 'thin' },
        bottom: { style: 'thin' },
        left: { style: 'thin' },
        right: { style: 'thin' },
      };
    }

    // Блок с финальной сводкой Лауры — пошлина, НДС, сбор, итого платежей.
    const s = invoice.summary;
    if (s && typeof s.cost_usd === 'number') {
      let r = totalRow + 2;
      const writeKV = (k: string, v: string | number) => {
        ws.getCell(`F${r}`).value = k;
        ws.getCell(`F${r}`).font = { bold: true };
        ws.getCell(`H${r}`).value = typeof v === 'number' ? Math.round(v * 100) / 100 : v;
        if (typeof v === 'number') ws.getCell(`H${r}`).numFmt = '#,##0.00';
        r += 1;
      };
      writeKV('Стоимость партии, $:', s.cost_usd);
      writeKV('Пошлина, $:', s.duty_usd);
      writeKV('НДС 16%, $:', s.vat_usd);
      writeKV('Таможенный сбор, $:', s.fee_usd);
      writeKV('ВСЕГО ПЛАТЕЖЕЙ, $:', s.total_payments_usd);
    }
  }

  const dir = join(tmpdir(), 'tnved-invoices');
  await mkdir(dir, { recursive: true });
  const fileName = `invoice_${invoice.invoice_number ?? invoice.id}.xlsx`;
  const filePath = join(dir, fileName);
  await wb.xlsx.writeFile(filePath);
  return filePath;
}

export class MockApiClient implements ApiClient {
  async listClients(): Promise<string[]> {
    return CLIENTS;
  }

  async uploadFile(input: UploadInput): Promise<UploadResult> {
    const invoiceNumber = await generateInvoiceNumber();
    // Encode filename into source_file_url so we can recover it during classify.
    // Format: "tg:<file_id>?name=<filename>"
    let storedUrl: string | null = input.fileUrl ?? null;
    if (storedUrl?.startsWith('tg:')) {
      storedUrl = `${storedUrl}?name=${encodeURIComponent(input.fileName)}`;
    }
    const { data, error } = await supabase
      .from('invoices')
      .insert({
        invoice_number: invoiceNumber,
        client_name: input.clientName,
        status: 'UPLOADED' as InvoiceStatus,
        source_file_url: storedUrl,
        telegram_chat_id: input.telegramChatId,
        created_by: input.createdById,
        assigned_to: input.assignedToId,
      })
      .select('id, invoice_number')
      .single();
    if (error) throw error;

    // Peek at the file at upload time so the user sees the real row count.
    // Weights and total quantity will be computed by Claude during classification.
    let itemsCount = 0;
    if (input.fileUrl?.startsWith('tg:') && input.fileName.toLowerCase().endsWith('.xlsx')) {
      try {
        const fileId = input.fileUrl.slice('tg:'.length);
        const buf = await fetchTelegramFile(fileId);
        const parsed = await parseXlsxBuffer(buf, input.fileName);
        itemsCount = parsed.totalRows;
        logger.info({ fileName: input.fileName, rows: parsed.totalRows }, 'preview parse ok');
      } catch (err) {
        logger.warn({ err, fileName: input.fileName }, 'upload-time preview parse failed');
      }
    }

    return {
      invoiceId: data.id,
      invoiceNumber: data.invoice_number,
      itemsCount,
      grossKg: 0,
      unitsTotal: 0,
    };
  }

  async classify(invoiceId: string, mode: PriceMode, value?: number): Promise<void> {
    await setInvoiceFields(invoiceId, {
      status: 'PROCESSING' as InvoiceStatus,
      price_mode: mode,
      price_value: value ?? null,
    });

    const useClaude = isClaudeEnabled();
    // Run the pipeline asynchronously — Claude calls take 30-90s for a full
    // packing list (3 agent passes).
    setImmediate(() => {
      void (async () => {
        try {
          if (!useClaude) {
            throw new Error(
              'Не настроен ANTHROPIC_API_KEY — реальная классификация невозможна. ' +
                'Свяжись с администратором.',
            );
          }
          const inv = await getInvoiceRow(invoiceId);
          const fileRef = inv.source_file_url ?? '';
          if (!fileRef.startsWith('tg:')) {
            throw new Error('Файл packing list не привязан к инвойсу. Попробуй /new заново.');
          }

          const { items, summary } = await classifyFromUploadedFile(
            fileRef,
            inv.client_name,
            mode,
            value,
          );
          await setInvoiceFields(invoiceId, {
            status: 'REVIEW' as InvoiceStatus,
            items,
            summary,
          });
          logger.info({ invoiceId, count: items.length }, 'pipeline classification done');
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.error({ err, invoiceId, msg }, 'pipeline failed');
          await setInvoiceFields(invoiceId, {
            status: 'FAILED' as InvoiceStatus,
            // Stash the error message in summary so the bot can show it.
            summary: { error: msg } as unknown as InvoiceState['summary'],
          }).catch(() => {});
        }
      })();
    });
  }

  async getInvoice(invoiceId: string): Promise<InvoiceState> {
    return getInvoiceRow(invoiceId);
  }

  async patchItem(invoiceId: string, itemIndex: number, newCode: string): Promise<void> {
    const inv = await getInvoiceRow(invoiceId);
    if (!inv.items) return;
    const items = inv.items.map((it) => {
      if (it.index !== itemIndex) return it;
      const hit = TNVED_CATALOG.find((c) => c.code === newCode);
      return {
        ...it,
        tnved_code: newCode,
        tnved_description: hit?.description ?? it.tnved_description,
        duty_rate: hit?.duty_rate ?? it.duty_rate,
        needs_review: false,
        confidence: Math.max(it.confidence, 95),
      };
    });
    await setInvoiceFields(invoiceId, { items });
  }

  async approve(invoiceId: string): Promise<ApproveResult> {
    const inv = await getInvoiceRow(invoiceId);
    const filePath = await buildXlsx(inv);
    await setInvoiceFields(invoiceId, {
      status: 'APPROVED' as InvoiceStatus,
      result_file_url: filePath,
      approved_at: new Date().toISOString(),
    });
    return { filePath, fileName: `invoice_${inv.invoice_number}.xlsx` };
  }

  async searchTnved(query: string): Promise<TnvedHit[]> {
    const q = query.trim().toLowerCase();
    if (!q) return TNVED_CATALOG.slice(0, 5);
    return TNVED_CATALOG.filter(
      (c) => c.code.includes(q) || c.description.toLowerCase().includes(q),
    ).slice(0, 5);
  }
}
