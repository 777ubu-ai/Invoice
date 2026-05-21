import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ExcelJS from 'exceljs';
import { supabase } from './supabase.js';
import { logger } from '../utils/logger.js';
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

// Canned items mirror the example from TZ section 4.2 (67 items condensed to 7 codes).
function buildCannedItems(): InvoiceItem[] {
  const base: Omit<InvoiceItem, 'index'>[] = [
    {
      article: 'WC-101',
      text_original: '陶瓷座便器 WC-101',
      text_translated: 'Унитаз фарфоровый',
      quantity: 120,
      gross_kg: 7200,
      net_kg: 6840,
      tnved_code: '6910100000',
      tnved_description: 'Сантехника фарфоровая',
      duty_rate: 12,
      confidence: 96,
      needs_review: false,
    },
    {
      article: 'SH-205',
      text_original: '不锈钢淋浴头 SH-205',
      text_translated: 'Лейка душевая из нержавеющей стали',
      quantity: 3400,
      gross_kg: 4080,
      net_kg: 3876,
      tnved_code: '7324900000',
      tnved_description: 'Сантехника из чёрных металлов',
      duty_rate: 10,
      confidence: 92,
      needs_review: false,
    },
    {
      article: 'PP-3-32',
      text_original: 'PP管件 32mm',
      text_translated: 'Фитинги PP 32мм',
      quantity: 85000,
      gross_kg: 8500,
      net_kg: 8075,
      tnved_code: '3917400000',
      tnved_description: 'Фитинги пластиковые',
      duty_rate: 6.5,
      confidence: 94,
      needs_review: false,
    },
    {
      article: 'BV-1/2',
      text_original: '黄铜球阀 1/2',
      text_translated: 'Шаровой кран латунный 1/2"',
      quantity: 2200,
      gross_kg: 1980,
      net_kg: 1881,
      tnved_code: '8481808199',
      tnved_description: 'Краны латунные',
      duty_rate: 5,
      confidence: 89,
      needs_review: false,
    },
    {
      article: 'EL-90',
      text_original: '钢制弯头 90度',
      text_translated: 'Отвод стальной 90°',
      quantity: 8500,
      gross_kg: 7650,
      net_kg: 7267,
      tnved_code: '7307990000',
      tnved_description: 'Прочие фитинги из чёрных металлов',
      duty_rate: 5,
      confidence: 91,
      needs_review: false,
    },
    {
      article: 'K48-12',
      text_original: '金属配件 K48',
      text_translated: 'Металлические фитинги K48',
      quantity: 1920,
      gross_kg: 384,
      net_kg: 365,
      tnved_code: '7412200000',
      tnved_description: 'Фитинги для труб из медных сплавов',
      duty_rate: 3,
      confidence: 65,
      needs_review: true,
      review_reason: 'Низкая уверенность модели',
      alternatives: [
        { code: '7412200000', description: 'Фитинги из медных сплавов' },
        { code: '7415310000', description: 'Гайки, шурупы из меди' },
        { code: '8481808199', description: 'Краны латунные' },
      ],
    },
    {
      article: 'M58-XX',
      text_original: '配件 M58',
      text_translated: 'Фитинг M58',
      quantity: 1230,
      gross_kg: 1386,
      net_kg: 1317,
      tnved_code: '7307990000',
      tnved_description: 'Прочие фитинги из чёрных металлов',
      duty_rate: 5,
      confidence: 72,
      needs_review: true,
      review_reason: 'Фото нечёткое',
      alternatives: [
        { code: '7307990000', description: 'Прочие фитинги из чёрных металлов' },
        { code: '7412200000', description: 'Фитинги из медных сплавов' },
      ],
    },
  ];
  return base.map((item, idx) => ({ ...item, index: idx + 1 }));
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
  let cost: number;
  if (mode === 'TARGET_PAYMENTS' && value) {
    // duty + vat(16%) + fee ≈ value;  cost is the major source — fit numerically.
    const avgDuty = 0.066;
    const vatRate = 0.16;
    const fee = 46;
    const denom = avgDuty + vatRate * (1 + avgDuty);
    cost = Math.round((value - fee) / denom);
  } else if (mode === 'PRICE_PER_KG' && value) {
    cost = Math.round(net * value);
  } else {
    cost = 20875;
  }

  const duty = Math.round(
    items.reduce((s, i) => s + (cost * i.gross_kg) / gross * (i.duty_rate / 100), 0),
  );
  const vat = Math.round((cost + duty) * 0.16);
  const fee = 46;
  const total = duty + vat + fee;

  return {
    items_count: 67,
    codes_count: new Set(items.map((i) => i.tnved_code)).size,
    gross_kg: 31176,
    net_kg: 29618,
    units_total: 213670,
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

async function buildXlsx(invoice: InvoiceState): Promise<string> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'TNVED.ai bot';
  const sheetName = invoice.invoice_number?.slice(-4) ?? '0001';
  const ws = wb.addWorksheet(sheetName);

  // Column widths to match the LINEA TRANSIT template.
  const widths = [18, 50, 14, 10, 12, 12, 12, 14];
  widths.forEach((w, i) => {
    ws.getColumn(i + 1).width = w;
  });

  const items = invoice.items ?? [];
  const summary = invoice.summary;
  const totalNet = items.reduce((s, it) => s + it.net_kg, 0);
  const totalCost = summary?.cost_usd ?? 0;

  // Per-item cost = proportional share of total cost by net weight.
  const itemCost = (it: { net_kg: number }) =>
    totalNet > 0 ? Math.round((totalCost * it.net_kg) / totalNet * 100) / 100 : 0;

  // ---------- Header section ----------
  ws.getCell('A1').value = 'ГРУЗООТПРАВИТЕЛЬ';
  ws.getCell('A1').font = { bold: true };
  ws.getCell('C1').value = 'XINJIANG TERRITORY VERTICAL ELECTRONIC COMMERCE.,LTD';
  ws.getCell('C2').value =
    'COMPANY ADDRESS: ADD: YILI PREFECTURE IN XINJIANG PROVINCE LANZHOU, HUOERGOS CITY RIVERSIDE ROADLANE 1, ROOM 201, BUILDING 1 UNIT';
  ws.getCell('C2').alignment = { wrapText: true };

  ws.getCell('A4').value = 'ГРУЗОПОЛУЧАТЕЛЬ';
  ws.getCell('A4').font = { bold: true };

  if (invoice.client_name.includes('LINEA')) {
    ws.getCell('C4').value = 'ТОО "LINEA TRANSIT"  БИН: 2604 4003 9864';
    ws.getCell('C5').value =
      'РК, область Жетісу, город Талдыкорган, улица Абылай хана, дом 363';
  } else {
    ws.getCell('C4').value = invoice.client_name;
  }
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
  const headers = [
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
  items.forEach((item, idx) => {
    const r = START_ROW + idx;
    if (idx === 0) {
      ws.getCell(`A${r}`).value = 'САНТЕХНИКА - САНИТАРНО-ТЕХНИЧЕСКОЕ ОБОРУДОВАНИЕ';
      ws.getCell(`A${r}`).alignment = { wrapText: true, vertical: 'top' };
    }
    ws.getCell(`B${r}`).value = item.text_translated.toUpperCase();
    ws.getCell(`B${r}`).alignment = { wrapText: true, vertical: 'top' };
    ws.getCell(`C${r}`).value = Number(item.tnved_code);
    ws.getCell(`D${r}`).value = Math.max(1, Math.ceil(item.quantity / 100));
    ws.getCell(`E${r}`).value = item.quantity;
    ws.getCell(`F${r}`).value = item.net_kg;
    ws.getCell(`G${r}`).value = item.gross_kg;
    ws.getCell(`H${r}`).value = itemCost(item);
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

  // ---------- Totals row ----------
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
    const { data, error } = await supabase
      .from('invoices')
      .insert({
        invoice_number: invoiceNumber,
        client_name: input.clientName,
        status: 'UPLOADED' as InvoiceStatus,
        source_file_url: input.fileUrl ?? null,
        telegram_chat_id: input.telegramChatId,
        created_by: input.createdById,
        assigned_to: input.assignedToId,
      })
      .select('id, invoice_number')
      .single();
    if (error) throw error;

    return {
      invoiceId: data.id,
      invoiceNumber: data.invoice_number,
      itemsCount: 67,
      grossKg: 31176,
      unitsTotal: 213670,
    };
  }

  async classify(invoiceId: string, mode: PriceMode, value?: number): Promise<void> {
    await setInvoiceFields(invoiceId, {
      status: 'PROCESSING' as InvoiceStatus,
      price_mode: mode,
      price_value: value ?? null,
    });

    setTimeout(() => {
      void (async () => {
        try {
          const items = buildCannedItems();
          const summary = computeSummary(items, mode, value);
          await setInvoiceFields(invoiceId, {
            status: 'REVIEW' as InvoiceStatus,
            items,
            summary,
          });
          logger.info({ invoiceId }, 'mock classification done');
        } catch (err) {
          logger.error({ err, invoiceId }, 'mock classification failed');
          await setInvoiceFields(invoiceId, { status: 'FAILED' as InvoiceStatus }).catch(() => {});
        }
      })();
    }, CLASSIFICATION_DELAY_MS);
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
