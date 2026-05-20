import type { InvoiceState } from '../services/api.types.js';

const RUB = new Intl.NumberFormat('ru-RU');

export function fmt(n: number | null | undefined): string {
  if (n == null) return '—';
  return RUB.format(Math.round(n));
}

export function invoiceSummaryText(inv: InvoiceState): string {
  const s = inv.summary;
  const lines: string[] = [];
  lines.push('━━━━━━━━━━━━━━━━━━━━');
  lines.push(`📊 Инвойс #${inv.invoice_number ?? inv.id.slice(0, 8)}`);
  lines.push(`Клиент: ${inv.client_name}`);
  if (s) {
    lines.push(`Позиций: ${s.items_count} → ${s.codes_count} кодов ТН ВЭД`);
    lines.push('━━━━━━━━━━━━━━━━━━━━');
    lines.push(`Брутто: ${fmt(s.gross_kg)} кг → Нетто: ${fmt(s.net_kg)} кг`);
    lines.push(`Стоимость: $${fmt(s.cost_usd)}`);
    lines.push(`Пошлина: $${fmt(s.duty_usd)}`);
    lines.push(`НДС 16%: $${fmt(s.vat_usd)}`);
    lines.push(`Сбор: $${fmt(s.fee_usd)}`);
    lines.push('━━━━━━━━━━━━━━━━━━━━');
    const targetLine = s.target_usd
      ? `ВСЕГО ПЛАТЕЖЕЙ: $${fmt(s.total_payments_usd)} (цель $${fmt(s.target_usd)}) ✓`
      : `ВСЕГО ПЛАТЕЖЕЙ: $${fmt(s.total_payments_usd)}`;
    lines.push(targetLine);
    lines.push('━━━━━━━━━━━━━━━━━━━━');
  }
  const review = (inv.items ?? []).filter((i) => i.needs_review);
  if (review.length > 0) {
    lines.push(`⚠️ ${review.length} позиций требуют ревью:`);
    for (const it of review) {
      lines.push(`  • #${it.index}: «${it.text_original}» (уверенность ${it.confidence}%)`);
    }
  }
  return lines.join('\n');
}

export function invoiceShortLine(inv: InvoiceState): string {
  const num = inv.invoice_number ?? inv.id.slice(0, 8);
  const status = STATUS_RU[inv.status] ?? inv.status;
  return `• #${num} ${inv.client_name} — ${status}`;
}

const STATUS_RU: Record<string, string> = {
  CREATED: '🆕 создан',
  UPLOADED: '📥 загружен',
  PROCESSING: '⏳ классификация',
  REVIEW: '🔍 на ревью',
  APPROVED: '✅ одобрен',
  FAILED: '❌ ошибка',
  CANCELED: '🚫 отменён',
};
