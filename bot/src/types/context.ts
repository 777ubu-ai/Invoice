import type { Context, SessionFlavor } from 'grammy';
import type { Conversation, ConversationFlavor } from '@grammyjs/conversations';
import type { TelegramUser } from './user.js';

export interface SessionData {
  lastInvoiceId?: string;
}

export type BotContext = Context &
  SessionFlavor<SessionData> &
  ConversationFlavor & {
    dbUser?: TelegramUser;
  };

export type BotConversation = Conversation<BotContext>;
