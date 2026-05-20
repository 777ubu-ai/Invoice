import { InlineKeyboard } from 'grammy';
import type { Role } from '../types/user.js';

export function mainMenu(role: Role): InlineKeyboard {
  const kb = new InlineKeyboard()
    .text('📤 Новый инвойс', 'menu:new')
    .text('📋 Мои задачи', 'menu:list')
    .row()
    .text('📜 История', 'menu:history')
    .text('👥 Мои клиенты', 'menu:clients')
    .row();

  if (role === 'OPERATOR') {
    kb.text('❓ Помощь руководителя', 'menu:help_manager').row();
  }
  if (role === 'MANAGER') {
    kb.text('👥 Команда', 'menu:team').text('📊 Стата команды', 'menu:team_stats').row();
    kb.text('❓ Помощь OWNER', 'menu:help_owner').row();
  }
  if (role === 'OWNER') {
    kb.text('🛠 Админ-меню', 'menu:admin').row();
  }
  return kb;
}
