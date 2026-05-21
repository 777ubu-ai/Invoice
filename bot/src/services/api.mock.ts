import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ExcelJS from 'exceljs';
import { supabase } from './supabase.js';
import { logger } from '../utils/logger.js';
import {
  runClassificationPipeline,
  isClaudeEnabled,
  type ReviewedItem,
} from './classifier.js';
import { fetchTelegramFile } from './file-fetcher.js';
import { parseXlsxBuffer, rowsAsText } from './xlsx-parser.js';
import type {
  ApiClient,
  ApproveResult,
  InvoiceItem,
  InvoiceState,
  InvoiceStatus,
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

// Download the uploaded packing list, parse xlsx, run the 3-agent pipeline.
// Throws (with a Russian error message) on any failure — no silent fallback.
async function classifyFromUploadedFile(fileRef: string): Promise<InvoiceItem[]> {
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
  const reviewed: ReviewedItem[] = await runClassificationPipeline(fileText, (p) => {
    logger.info({ stage: p.stage, label: p.label }, 'pipeline progress');
  });

  if (reviewed.length === 0) {
    throw new Error('Pipeline вернул 0 позиций.');
  }

  return reviewed.map((it, idx) => ({
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
  }));
}


function computeSummary(
  items: InvoiceItem[],
  mode: PriceMode,
  value: number | undefined,
): InvoiceState['summary'] {
  const gross = items.reduce((s, i) => s + i.gross_kg, 0);
  const net = items.reduce((s, i) => s + i.net_kg, 0);
  const units = items.reduce((s, i) => s + i.quantity, 0);

  // Cost backsolved to hit `value` total payments when mode is TARGET_PAYMENTS.
  // Fixed cost for other modes to keep mock deterministic.
  // Customs fee: 26 000 KZT fixed (≈ $54 at 480 KZT/USD).
  const CUSTOMS_FEE_USD = 54;

  let cost: number;
  if (mode === 'TARGET_PAYMENTS' && value) {
    // duty + vat(16%) + fee ≈ value;  cost is the major source — fit numerically.
    const avgDuty = 0.066;
    const vatRate = 0.16;
    const denom = avgDuty + vatRate * (1 + avgDuty);
    cost = Math.round((value - CUSTOMS_FEE_USD) / denom);
  } else if (mode === 'PRICE_PER_KG' && value) {
    cost = Math.round(net * value);
  } else {
    cost = 20875;
  }

  const duty = Math.round(
    items.reduce((s, i) => s + (cost * i.gross_kg) / gross * (i.duty_rate / 100), 0),
  );
  const vat = Math.round((cost + duty) * 0.16);
  const fee = CUSTOMS_FEE_USD;
  const total = duty + vat + fee;

  return {
    items_count: items.length,
    codes_count: new Set(items.map((i) => i.tnved_code)).size,
    gross_kg: gross,
    net_kg: net,
    units_total: units,
    cost_usd: cost,
    duty_usd: duty,
    vat_usd: vat,
    fee_usd: fee,
    total_payments_usd: total,
    target_usd: mode === 'TARGET_PAYMENTS' ? value : undefined,
  };
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

  // ---------- Item rows ----------
  const START_ROW = HEADER_ROW + 1;
  const PRICE = profile.pricePerNetKg;
  items.forEach((item, idx) => {
    const r = START_ROW + idx;
    if (idx === 0) {
      ws.getCell(`A${r}`).value = profile.category;
      ws.getCell(`A${r}`).alignment = { wrapText: true, vertical: 'top' };
      ws.getCell(`A${r}`).font = { bold: true };
    }
    ws.getCell(`B${r}`).value = (item.text_translated || item.text_original || '').toUpperCase();
    ws.getCell(`B${r}`).alignment = { wrapText: true, vertical: 'top' };
    ws.getCell(`C${r}`).value = Number(item.tnved_code);
    ws.getCell(`D${r}`).value = Math.max(1, Math.ceil((item.quantity || 1) / 1));
    ws.getCell(`E${r}`).value = item.quantity || 0;
    ws.getCell(`F${r}`).value = item.net_kg || 0;
    ws.getCell(`G${r}`).value = item.gross_kg || 0;
    // Cost = net_kg × client rate, expressed as a formula so it's editable.
    ws.getCell(`H${r}`).value = { formula: `F${r}*${PRICE}` };
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

  // ---------- ИТОГО row ----------
  if (items.length > 0) {
    const lastItemRow = START_ROW + items.length - 1;
    const totalRow = lastItemRow + 2;
    ws.getCell(`C${totalRow}`).value = 'ИТОГО:';
    ws.getCell(`D${totalRow}`).value = { formula: `SUM(D${START_ROW}:D${lastItemRow})` };
    ws.getCell(`E${totalRow}`).value = { formula: `SUM(E${START_ROW}:E${lastItemRow})` };
    ws.getCell(`F${totalRow}`).value = { formula: `SUM(F${START_ROW}:F${lastItemRow})` };
    ws.getCell(`G${totalRow}`).value = { formula: `SUM(G${START_ROW}:G${lastItemRow})` };
    ws.getCell(`H${totalRow}`).value = { formula: `SUM(H${START_ROW}:H${lastItemRow})` };
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

          const items = await classifyFromUploadedFile(fileRef);
          const summary = computeSummary(items, mode, value);
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
