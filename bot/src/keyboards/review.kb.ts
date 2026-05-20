import { InlineKeyboard } from 'grammy';
import type { InvoiceItem, InvoiceState } from '../services/api.types.js';

export function reviewKeyboard(inv: InvoiceState): InlineKeyboard {
  const kb = new InlineKeyboard();
  const review = (inv.items ?? []).filter((i) => i.needs_review);
  for (const it of review) {
    kb.text(`👁 Посмотреть #${it.index}`, `inv:item:${inv.id}:${it.index}`).row();
  }
  kb.text('✅ Одобрить', `inv:approve:${inv.id}`).text('❌ Отменить', `inv:cancel:${inv.id}`);
  return kb;
}

export function itemKeyboard(invoiceId: string, item: InvoiceItem): InlineKeyboard {
  const kb = new InlineKeyboard();
  kb.text(`✅ Оставить ${item.tnved_code}`, `inv:keep:${invoiceId}:${item.index}`).row();
  let i = 1;
  for (const alt of item.alternatives ?? []) {
    if (alt.code === item.tnved_code) continue;
    kb.text(`Выбрать ${alt.code}`, `inv:pick:${invoiceId}:${item.index}:${alt.code}`).row();
    if (++i > 4) break;
  }
  kb.text('🔙 К инвойсу', `inv:back:${invoiceId}`);
  return kb;
}

export function priceModeKeyboard(invoiceId: string): InlineKeyboard {
  return new InlineKeyboard()
    .text('💰 Целевые платежи $', `inv:mode:${invoiceId}:TARGET_PAYMENTS`)
    .text('⚖️ Цена за кг', `inv:mode:${invoiceId}:PRICE_PER_KG`)
    .row()
    .text('📋 Прайс клиента', `inv:mode:${invoiceId}:CLIENT_PRICELIST`)
    .text('📊 Индикатив КГД', `inv:mode:${invoiceId}:KGD_INDICATIVE`);
}

export function clientsKeyboard(clients: string[]): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const c of clients) {
    kb.text(c, `inv:client:${encodeURIComponent(c)}`).row();
  }
  kb.text('❌ Отменить', 'inv:newcancel');
  return kb;
}
