import type { Api, InlineKeyboard } from 'grammy';
import { logger } from '../utils/logger.js';

let botApi: Api | null = null;

export function setBotApi(api: Api): void {
  botApi = api;
}

export async function notifyUser(
  telegramUserId: number,
  text: string,
  keyboard?: InlineKeyboard,
): Promise<void> {
  if (!botApi) {
    logger.warn('notifyUser called before bot is initialised');
    return;
  }
  try {
    await botApi.sendMessage(telegramUserId, text, {
      reply_markup: keyboard,
    });
  } catch (err) {
    // User may have blocked the bot, or chat doesn't exist. Don't crash.
    logger.warn({ err, telegramUserId }, 'notifyUser failed');
  }
}
