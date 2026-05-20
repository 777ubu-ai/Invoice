import { InlineKeyboard } from 'grammy';

export function adminMenu(): InlineKeyboard {
  return new InlineKeyboard()
    .text('👥 Все пользователи', 'adm:users')
    .text('🎯 Назначить MANAGER', 'adm:addmanager')
    .row()
    .text('📊 Все инвойсы', 'adm:invoices')
    .text('💰 Биллинг', 'adm:billing')
    .row()
    .text('📢 Рассылка', 'adm:broadcast')
    .text('🗄 Резервная копия', 'adm:backup');
}
