import { InlineKeyboard } from 'grammy';
import type { BotContext, BotConversation } from '../types/context.js';
import * as Help from '../services/help.repo.js';
import { listAssignedActive } from '../services/invoices.repo.js';
import { supabase } from '../services/supabase.js';
import { audit } from '../services/audit.repo.js';
import { notifyUser } from '../services/notifications.js';

export async function helpRequestConversation(
  conversation: BotConversation,
  ctx: BotContext,
): Promise<void> {
  const u = ctx.dbUser;
  if (!u) return;

  // OPERATOR -> own MANAGER. MANAGER -> OWNER.
  let recipientId: string | null = null;
  let recipientLabel = '';
  if (u.role === 'OPERATOR') {
    if (!u.manager_id) {
      await ctx.reply('У тебя не назначен MANAGER. Свяжись с OWNER.');
      return;
    }
    recipientId = u.manager_id;
    recipientLabel = 'руководителя';
  } else if (u.role === 'MANAGER') {
    const { data } = await supabase
      .from('telegram_users')
      .select('id, full_name, telegram_user_id')
      .eq('role', 'OWNER')
      .maybeSingle();
    if (!data) {
      await ctx.reply('OWNER не найден в системе.');
      return;
    }
    recipientId = data.id;
    recipientLabel = 'OWNER';
  } else {
    await ctx.reply('OWNER не может запросить помощь у руководителя 🙂');
    return;
  }

  // Pick active invoice (optional).
  const active = await listAssignedActive(u.id);
  let invoiceId: string | null = null;
  if (active.length > 0) {
    const kb = new InlineKeyboard();
    for (const inv of active) {
      kb.text(`#${inv.invoice_number ?? inv.id.slice(0, 8)} ${inv.client_name}`, `help:inv:${inv.id}`).row();
    }
    kb.text('Без инвойса', 'help:inv:none');
    await ctx.reply('По какому инвойсу нужна помощь?', { reply_markup: kb });
    const pick = await conversation.waitFor('callback_query:data');
    await pick.answerCallbackQuery();
    const m = pick.callbackQuery.data.match(/^help:inv:(.+)$/);
    if (m && m[1] !== 'none') invoiceId = m[1]!;
  }

  await ctx.reply('Опиши проблему (1-2 предложения):');
  const descMsg = await conversation.waitFor(':text');
  const description = (descMsg.message?.text ?? '').trim();
  if (!description) {
    await ctx.reply('Описание пустое. Отменено.');
    return;
  }

  if (!recipientId) return;
  const req = await Help.create({
    from_user_id: u.id,
    to_user_id: recipientId,
    invoice_id: invoiceId,
    description,
  });

  await audit({
    actor_user_id: u.id,
    action: 'HELP_REQUESTED',
    target_type: 'help_request',
    target_id: req.id,
    payload: { to: recipientId, invoice: invoiceId },
  });

  await ctx.reply(`✅ ${recipientLabel === 'OWNER' ? 'OWNER' : 'Руководитель'} уведомлён(а). Жди ответа.`);

  // Notify recipient.
  const { data: recipient } = await supabase
    .from('telegram_users')
    .select('telegram_user_id')
    .eq('id', recipientId)
    .maybeSingle();
  if (recipient?.telegram_user_id) {
    const invLine = invoiceId ? `\nИнвойс: #${invoiceId.slice(0, 8)}` : '';
    await notifyUser(
      Number(recipient.telegram_user_id),
      `🔔 ${u.full_name} просит помощи${invLine}\nПроблема: «${description}»`,
    );
  }
}
