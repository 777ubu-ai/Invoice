import { InlineKeyboard } from 'grammy';
import type { BotContext, BotConversation } from '../types/context.js';
import { api } from '../services/api.js';
import { audit } from '../services/audit.repo.js';
import { priceModeKeyboard, clientsKeyboard, reviewKeyboard } from '../keyboards/review.kb.js';
import { invoiceSummaryText } from '../utils/format.js';
import { logger } from '../utils/logger.js';
import type { PriceMode } from '../services/api.types.js';

const PRICE_MODE_LABEL: Record<PriceMode, string> = {
  TARGET_PAYMENTS: 'Целевые платежи $',
  PRICE_PER_KG: 'Цена за кг',
  CLIENT_PRICELIST: 'Прайс клиента',
  KGD_INDICATIVE: 'Индикатив КГД',
};

export async function newInvoiceConversation(
  conversation: BotConversation,
  ctx: BotContext,
): Promise<void> {
  const user = ctx.dbUser;
  if (!user) return;

  // 1. Pick client.
  const available = user.client_access.includes('*')
    ? await api.listClients()
    : user.client_access;

  if (available.length === 0) {
    await ctx.reply('⚠️ Тебе не назначен ни один клиент. Попроси руководителя.');
    return;
  }

  await ctx.reply('Выбери клиента:', { reply_markup: clientsKeyboard(available) });

  const clientCb = await conversation.waitFor('callback_query:data');
  const clientData = clientCb.callbackQuery.data;
  await clientCb.answerCallbackQuery();
  if (clientData === 'inv:newcancel') {
    await ctx.reply('Отменено.');
    return;
  }
  const clientName = clientData.startsWith('inv:client:')
    ? decodeURIComponent(clientData.slice('inv:client:'.length))
    : null;
  if (!clientName || !available.includes(clientName)) {
    await ctx.reply('Клиент не распознан. Попробуй /new ещё раз.');
    return;
  }

  // 2. Ask for file.
  await ctx.reply(`Клиент: ${clientName}\n\nОтправь packing list (xlsx, pdf или фото).`);
  const fileMsg = await conversation.waitFor([':document', ':photo']);
  let fileName = 'packing-list';
  let fileUrl: string | undefined;
  if (fileMsg.message?.document) {
    fileName = fileMsg.message.document.file_name ?? fileName;
    fileUrl = `tg:${fileMsg.message.document.file_id}`;
  } else if (fileMsg.message?.photo) {
    fileName = 'packing-list.jpg';
    const ph = fileMsg.message.photo[fileMsg.message.photo.length - 1];
    if (ph) fileUrl = `tg:${ph.file_id}`;
  }
  logger.info({ fileName, fileUrl }, 'received packing list');

  // 3. Upload to API (creates invoice row).
  const upload = await api.uploadFile({
    clientName,
    fileName,
    fileUrl,
    telegramChatId: ctx.chat?.id ?? 0,
    createdById: user.id,
    assignedToId: user.id,
  });

  await audit({
    actor_user_id: user.id,
    action: 'INVOICE_CREATED',
    target_type: 'invoice',
    target_id: upload.invoiceId,
    payload: { client: clientName, file: fileName },
  });

  const previewLines = [
    '✅ Файл получен',
    upload.itemsCount > 0
      ? `📊 ${upload.itemsCount} строк в файле (точное число позиций после классификации)`
      : '📊 Файл будет распарсен на этапе классификации',
    '',
    'Режим стоимости?',
  ].join('\n');
  await ctx.reply(previewLines, { reply_markup: priceModeKeyboard(upload.invoiceId) });

  // 4. Wait for mode.
  const modeCb = await conversation.waitFor('callback_query:data');
  await modeCb.answerCallbackQuery();
  const modeMatch = modeCb.callbackQuery.data.match(/^inv:mode:([^:]+):(TARGET_PAYMENTS|PRICE_PER_KG|CLIENT_PRICELIST|KGD_INDICATIVE)$/);
  if (!modeMatch) {
    await ctx.reply('Режим не распознан. Попробуй ещё раз через /new.');
    return;
  }
  const mode = modeMatch[2] as PriceMode;

  // 5. Ask for value if needed.
  let value: number | undefined;
  if (mode === 'TARGET_PAYMENTS') {
    await ctx.reply('Сколько $? Например: 5000');
    const valMsg = await conversation.waitFor(':text');
    const parsed = Number(valMsg.message?.text?.replace(/[^\d.]/g, ''));
    if (!parsed || parsed <= 0) {
      await ctx.reply('Не похоже на сумму. Попробуй /new ещё раз.');
      return;
    }
    value = parsed;
  } else if (mode === 'PRICE_PER_KG') {
    await ctx.reply('Цена за кг ($)? Например: 0.7');
    const valMsg = await conversation.waitFor(':text');
    const parsed = Number(valMsg.message?.text?.replace(/[^\d.]/g, ''));
    if (!parsed || parsed <= 0) {
      await ctx.reply('Не похоже на число. Попробуй /new ещё раз.');
      return;
    }
    value = parsed;
  }

  // 6. Kick off classification.
  await api.classify(upload.invoiceId, mode, value);
  await audit({
    actor_user_id: user.id,
    action: 'INVOICE_CLASSIFY_STARTED',
    target_type: 'invoice',
    target_id: upload.invoiceId,
    payload: { mode, value },
  });

  const status = await ctx.reply('🔄 Запускаю классификатор...\n⏳ Это займёт 3-5 минут (3 агента + проверка)');
  const statusMessageId = status.message_id;

  // 7. Poll until REVIEW / FAILED. Pipeline = translator (~45s) + classifier (~2 min) + reviewer (~50s),
  //    plus jitter on long files. Give it 8 minutes total.
  const POLL_INTERVAL_SEC = 5;
  const MAX_ATTEMPTS = 96; // 96 * 5 = 480 s = 8 min
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    await conversation.sleep(POLL_INTERVAL_SEC * 1000);
    const inv = await api.getInvoice(upload.invoiceId);
    if (inv.status === 'REVIEW') {
      await ctx.api.editMessageText(
        status.chat.id,
        statusMessageId,
        `✅ Готово!\n\n${invoiceSummaryText(inv)}`,
        { reply_markup: reviewKeyboard(inv) },
      );
      ctx.session.lastInvoiceId = inv.id;
      return;
    }
    if (inv.status === 'FAILED') {
      const errMsg =
        (inv.summary as unknown as { error?: string } | null)?.error ??
        'Неизвестная ошибка классификации.';
      await ctx.api.editMessageText(
        status.chat.id,
        statusMessageId,
        `❌ Классификация не удалась:\n\n${errMsg}`,
        { reply_markup: new InlineKeyboard().text('🔄 Попробовать ещё раз', `inv:retry:${inv.id}`) },
      );
      return;
    }
    if (attempt > 0 && attempt % 6 === 0) {
      const elapsedSec = attempt * POLL_INTERVAL_SEC;
      const stageHint =
        elapsedSec < 60
          ? 'агент 1 (перевод)'
          : elapsedSec < 200
            ? 'агент 2 (коды ТН ВЭД)'
            : 'агент 3 (ревью)';
      await ctx.api.editMessageText(
        status.chat.id,
        statusMessageId,
        `🔄 Классификация: ${stageHint}... (${elapsedSec} сек)`,
      );
    }
  }

  await ctx.api.editMessageText(
    status.chat.id,
    statusMessageId,
    '⏰ Классификация идёт дольше обычного. Попробуй /list через минуту — возможно, инвойс готов.',
  );
}

export const NEW_INVOICE_CONV = 'newInvoice';
void PRICE_MODE_LABEL;
