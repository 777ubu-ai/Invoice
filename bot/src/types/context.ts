import type { Context, SessionFlavor } from 'grammy';
import type { TelegramUser } from './user.js';

export interface SessionData {
  // FSM-related fields will be added as conversations grow.
  lastInvoiceId?: string;
}

export type BotContext = Context &
  SessionFlavor<SessionData> & {
    dbUser?: TelegramUser;
  };
