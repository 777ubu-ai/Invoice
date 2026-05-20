import { Composer, InlineKeyboard, InputFile } from 'grammy';
import type { BotContext } from '../types/context.js';
import { api } from '../services/api.js';
import { audit } from '../services/audit.repo.js';
import { supabase } from '../services/supabase.js';
import { getById, reassign } from '../services/invoices.repo.js';
import { listOperatorsByManager, deactivateUser } from '../services/users.repo.js';
import { notifyUser } from '../services/notifications.js';
import { reviewKeyboard, itemKeyboard } from '../keyboards/review.kb.js';
import { reassignKeyboard } from '../keyboards/team.kb.js';
import { invoiceSummaryText } from '../utils/format.js';

export const callbacks = new Composer<BotContext>();

// --- Main menu shortcuts --------------------------------------------------
callbacks.callbackQuery(/^menu:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const action = ctx.match[1]!;
  const cmdMap: Record<string, string> = {
    new: 'new',
    list: 'list',
    history: 'history',
    clients: 'clients',
    help_manager: 'help_manager',
    help_owner: 'help_owner',
    team: 'team',
    team_stats: 'team_stats',
    admin: 'admin',
  };
  const cmd = cmdMap[action];
  if (!cmd) return;
  await ctx.reply(`Используй команду /${cmd}`);
});

// --- Invoice review interactions ------------------------------------------
callbacks.callbackQuery(/^inv:item:([^:]+):(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const invoiceId = ctx.match[1]!;
  const index = Number(ctx.match[2]);
  const inv = await getById(invoiceId);
  if (!inv?.items) return ctx.reply('Инвойс не найден.');
  const item = inv.items.find((i) => i.index === index);
  if (!item) return ctx.reply('Позиция не найдена.');

  const alts = (item.alternatives ?? [])
    .map((a, i) => `${i + 1}. ${a.code} — ${a.description}`)
    .join('\n');

  await ctx.reply(
    [
      `Позиция #${item.index}:`,
      `Артикул: ${item.article}`,
      `Текст: ${item.text_original} (${item.text_translated})`,
      `Кол-во: ${item.quantity} шт, Брутто: ${item.gross_kg} кг`,
      '━━━━━━━━━━━━━━━━━━━━',
      `Текущий код: ${item.tnved_code}`,
      `Описание: ${item.tnved_description}`,
      `Ставка пошлины: ${item.duty_rate}%`,
      `Уверенность LLM: ${item.confidence}% ${item.confidence < 80 ? '⚠️' : '✅'}`,
      '━━━━━━━━━━━━━━━━━━━━',
      'Альтернативы:',
      alts || '—',
    ].join('\n'),
    { reply_markup: itemKeyboard(invoiceId, item) },
  );
});

callbacks.callbackQuery(/^inv:keep:([^:]+):(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery('✓ Подтверждено');
  const invoiceId = ctx.match[1]!;
  const index = Number(ctx.match[2]);
  const inv = await getById(invoiceId);
  if (!inv?.items) return;
  const item = inv.items.find((i) => i.index === index);
  if (!item) return;
  await api.patchItem(invoiceId, index, item.tnved_code);
  await audit({
    actor_user_id: ctx.dbUser?.id ?? null,
    action: 'ITEM_KEPT',
    target_type: 'invoice',
    target_id: invoiceId,
    payload: { index, code: item.tnved_code },
  });
  const fresh = await getById(invoiceId);
  if (fresh) {
    await ctx.reply(invoiceSummaryText(fresh), { reply_markup: reviewKeyboard(fresh) });
  }
});

callbacks.callbackQuery(/^inv:pick:([^:]+):(\d+):(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery('✓ Применено');
  const invoiceId = ctx.match[1]!;
  const index = Number(ctx.match[2]);
  const code = ctx.match[3]!;
  await api.patchItem(invoiceId, index, code);
  await audit({
    actor_user_id: ctx.dbUser?.id ?? null,
    action: 'ITEM_PATCHED',
    target_type: 'invoice',
    target_id: invoiceId,
    payload: { index, code },
  });
  const fresh = await getById(invoiceId);
  if (fresh) {
    await ctx.reply(invoiceSummaryText(fresh), { reply_markup: reviewKeyboard(fresh) });
  }
});

callbacks.callbackQuery(/^inv:back:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const inv = await getById(ctx.match[1]!);
  if (inv) await ctx.reply(invoiceSummaryText(inv), { reply_markup: reviewKeyboard(inv) });
});

callbacks.callbackQuery(/^inv:approve:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const invoiceId = ctx.match[1]!;
  const inv = await getById(invoiceId);
  if (!inv) return ctx.reply('Инвойс не найден.');
  const remaining = (inv.items ?? []).filter((i) => i.needs_review);
  if (remaining.length > 0) {
    await ctx.reply(`⚠️ Сначала закрой ревью по ${remaining.length} позициям.`);
    return;
  }
  await ctx.reply('🔄 Генерирую инвойс...');
  const result = await api.approve(invoiceId);
  await audit({
    actor_user_id: ctx.dbUser?.id ?? null,
    action: 'INVOICE_APPROVED',
    target_type: 'invoice',
    target_id: invoiceId,
  });
  if (ctx.dbUser) {
    await supabase
      .from('telegram_users')
      .update({ invoices_total: ctx.dbUser.invoices_total + 1 })
      .eq('id', ctx.dbUser.id);
  }
  await ctx.replyWithDocument(new InputFile(result.filePath, result.fileName), {
    caption: '✓ Инвойс готов!',
  });
  await ctx.reply('Что дальше?', {
    reply_markup: new InlineKeyboard()
      .text('📝 Новый инвойс', 'menu:new')
      .text('📋 Мои задачи', 'menu:list'),
  });
});

callbacks.callbackQuery(/^inv:cancel:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const invoiceId = ctx.match[1]!;
  await supabase.from('invoices').update({ status: 'CANCELED' }).eq('id', invoiceId);
  await audit({
    actor_user_id: ctx.dbUser?.id ?? null,
    action: 'INVOICE_CANCELED',
    target_type: 'invoice',
    target_id: invoiceId,
  });
  await ctx.reply('🚫 Инвойс отменён.');
});

callbacks.callbackQuery(/^inv:retry:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.reply('Используй /new чтобы создать новый инвойс.');
});

// --- Team management ------------------------------------------------------
callbacks.callbackQuery('team:add', async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.reply('Используй команду /add_operator');
});

callbacks.callbackQuery('team:list', async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.reply('Используй команду /team_list');
});

callbacks.callbackQuery('team:stats', async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.reply('Используй команду /team_stats');
});

callbacks.callbackQuery(/^team:rm:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const userId = ctx.match[1]!;
  await deactivateUser(userId);
  await audit({
    actor_user_id: ctx.dbUser?.id ?? null,
    action: 'USER_DEACTIVATED',
    target_type: 'user',
    target_id: userId,
  });
  await ctx.reply('🗑 Оператор удалён из команды.');
});

callbacks.callbackQuery(/^team:open:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const invoiceId = ctx.match[1]!;
  const inv = await getById(invoiceId);
  if (!inv) return ctx.reply('Инвойс не найден.');
  const m = ctx.dbUser;
  if (!m) return;
  const team = await listOperatorsByManager(m.id);
  await ctx.reply(
    invoiceSummaryText(inv) + '\n\nПереназначить:',
    { reply_markup: reassignKeyboard(invoiceId, team) },
  );
});

callbacks.callbackQuery(/^team:reassign:([^:]+):(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const invoiceId = ctx.match[1]!;
  const newAssignee = ctx.match[2]!;
  const inv = await getById(invoiceId);
  if (!inv) return ctx.reply('Инвойс не найден.');
  const oldAssignee = (await supabase.from('invoices').select('assigned_to').eq('id', invoiceId).single())
    .data?.assigned_to as string | null;
  await reassign(invoiceId, newAssignee, oldAssignee ?? '');
  await audit({
    actor_user_id: ctx.dbUser?.id ?? null,
    action: 'INVOICE_REASSIGNED',
    target_type: 'invoice',
    target_id: invoiceId,
    payload: { from: oldAssignee, to: newAssignee },
  });
  await ctx.reply('✅ Инвойс переназначен.');
  // Notify both parties.
  const { data: actors } = await supabase
    .from('telegram_users')
    .select('id, telegram_user_id, full_name')
    .in('id', [oldAssignee, newAssignee].filter(Boolean) as string[]);
  for (const a of actors ?? []) {
    if (!a.telegram_user_id) continue;
    const text =
      a.id === newAssignee
        ? `📥 Тебе переназначен инвойс #${inv.invoice_number ?? inv.id.slice(0, 8)} (${inv.client_name}).`
        : `↪️ Инвойс #${inv.invoice_number ?? inv.id.slice(0, 8)} передан другому оператору.`;
    await notifyUser(Number(a.telegram_user_id), text);
  }
});

callbacks.callbackQuery('team:noop', async (ctx) => {
  await ctx.answerCallbackQuery('Отменено');
});

// --- Admin --------------------------------------------------------------
callbacks.callbackQuery('adm:users', async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.reply('Используй /all_users');
});
callbacks.callbackQuery('adm:invoices', async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.reply('Используй /all_invoices');
});
callbacks.callbackQuery('adm:addmanager', async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.reply('Используй /add_manager');
});
callbacks.callbackQuery('adm:billing', async (ctx) => {
  await ctx.answerCallbackQuery();
  const { count } = await supabase
    .from('invoices')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'APPROVED');
  await ctx.reply(
    `💰 Биллинг (mock):\n` +
      `Одобрено инвойсов: ${count ?? 0}\n` +
      `Расходы Claude API: $0 (mock-режим)\n` +
      `Выручка: $${(count ?? 0) * 50} (mock $50/инвойс)`,
  );
});
callbacks.callbackQuery('adm:broadcast', async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.reply('Используй /broadcast <текст>');
});
callbacks.callbackQuery('adm:backup', async (ctx) => {
  await ctx.answerCallbackQuery();
  await audit({
    actor_user_id: ctx.dbUser?.id ?? null,
    action: 'BACKUP_TRIGGERED',
  });
  await ctx.reply('🗄 Резервная копия запланирована (заглушка).');
});
