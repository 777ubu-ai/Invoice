import { describe, expect, it } from 'vitest';
import { invoiceShortLine, invoiceSummaryText, fmt } from '../src/utils/format.js';
import type { InvoiceState } from '../src/services/api.types.js';

const baseInvoice: InvoiceState = {
  id: 'abcdef12-3456-7890-abcd-ef1234567890',
  invoice_number: '2026-C351-0003',
  client_name: 'LINEA TRANSIT',
  status: 'REVIEW',
  price_mode: 'TARGET_PAYMENTS',
  price_value: 5000,
  summary: {
    items_count: 67,
    codes_count: 7,
    gross_kg: 31176,
    net_kg: 29618,
    units_total: 213670,
    cost_usd: 20875,
    duty_usd: 1370,
    vat_usd: 3559,
    fee_usd: 46,
    total_payments_usd: 4975,
    target_usd: 5000,
  },
  items: [
    {
      index: 1,
      article: 'K48-12',
      text_original: '金属配件 K48',
      text_translated: 'Металлические фитинги',
      quantity: 1920,
      gross_kg: 384,
      net_kg: 365,
      tnved_code: '7412200000',
      tnved_description: 'Фитинги',
      duty_rate: 3,
      confidence: 65,
      needs_review: true,
    },
  ],
  result_file_url: null,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

describe('format', () => {
  it('formats numbers with russian separators', () => {
    expect(fmt(31176)).toBe('31 176');
    expect(fmt(null)).toBe('—');
  });

  it('builds an invoice summary with target match line', () => {
    const text = invoiceSummaryText(baseInvoice);
    expect(text).toContain('LINEA TRANSIT');
    expect(text).toContain('Позиций: 67 → 7 кодов ТН ВЭД');
    expect(text).toContain('ВСЕГО ПЛАТЕЖЕЙ');
    expect(text).toContain('1 позиций требуют ревью');
  });

  it('renders short status line', () => {
    expect(invoiceShortLine(baseInvoice)).toBe('• #2026-C351-0003 LINEA TRANSIT — 🔍 на ревью');
  });
});
