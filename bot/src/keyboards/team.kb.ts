import { InlineKeyboard } from 'grammy';
import type { TelegramUser } from '../types/user.js';

export function teamKeyboard(team: TelegramUser[]): InlineKeyboard {
  const kb = new InlineKeyboard();
  kb.text('➕ Добавить оператора', 'team:add').row();
  kb.text('📋 Все задачи команды', 'team:list').text('📊 Статистика', 'team:stats').row();
  for (const op of team) {
    kb.text(`🗑 Удалить ${op.full_name}`, `team:rm:${op.id}`).row();
  }
  return kb;
}

export function reassignKeyboard(invoiceId: string, team: TelegramUser[]): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const member of team) {
    kb.text(member.full_name, `team:reassign:${invoiceId}:${member.id}`).row();
  }
  kb.text('🔙 Отмена', `team:noop`);
  return kb;
}
