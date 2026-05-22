import { InlineKeyboard } from 'grammy';
import type { InvoiceItem, InvoiceState } from '../services/api.types.js';

export function reviewKeyboard(inv: InvoiceState): InlineKeyboard {
  const kb = new InlineKeyboard();
  const items = inv.items ?? [];
  // Сначала позиции на ревью, потом остальные — чтобы первыми видны были спорные.
  const sorted = [...items].sort((a, b) => {
    if (a.needs_review !== b.needs_review) return a.needs_review ? -1 : 1;
    return a.confidence - b.confidence;
  });
  // Показываем до 30 кнопок чтобы не упереться в лимит Telegram (100 кнопок на сообщение).
  const visible = sorted.slice(0, 30);
  for (const it of visible) {
    const flag = it.needs_review ? '⚠️' : '✏️';
    const label = `${flag} #${it.index} ${it.tnved_code} (${it.confidence}%)`;
    kb.text(label, `inv:item:${inv.id}:${it.index}`).row();
  }
  if (items.length > visible.length) {
    kb.text(`…ещё ${items.length - visible.length} позиций (открой xlsx)`, `inv:noop:${inv.id}`).row();
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
  // Накопительная обратная связь для Маке.
  kb.text(`👍 Код верный`, `inv:fbgood:${invoiceId}:${item.index}`)
    .text(`🚩 Код неверный`, `inv:fbbad:${invoiceId}:${item.index}`)
    .row();
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
