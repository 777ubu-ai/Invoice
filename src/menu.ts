import { canPrepareInvoice, type BotKind, type Role } from './access.js';

// This catalog describes the agreed scope. No business operation is enabled yet.
export function plannedSections(kind: BotKind, roles: readonly Role[]): string[] {
  const owner = roles.includes('owner');
  if (kind === 'packing') {
    return [
      ...(owner || roles.includes('packing') ? ['Новый пакинг', 'Мои партии'] : []),
      'Проверка товаров и кодов ТН ВЭД', 'Расчёт ТПиН и кассы',
      'Согласование с клиентом', 'Передача в Invoice Bot',
      ...(owner ? ['Все партии и отчёты', 'Сетки и тарифы', 'Сотрудники и доступы'] : []),
    ];
  }
  return [
    ...(canPrepareInvoice(roles) ? ['Новый инвойс', 'Полученные партии', 'Компании и контракты', 'Проверка и выпуск документов'] : []),
    'Инвойсы и утверждённые расчёты',
    ...(owner || roles.includes('accountant') ? ['Оплаты и расходы', 'Задолженность', 'Авансы и депозиты', 'Финансовые выгрузки'] : []),
    ...(owner ? ['Общий реестр и маржа', 'Сотрудники и доступы', 'Закрытие партии'] : []),
  ];
}

export const HOME = {
  sections: '📋 Структура работы',
  access: '👤 Мой доступ',
  help: '❓ Помощь',
  grid: '🏷 Сетка ТН ВЭД',
} as const;

export function scopeText(kind: BotKind, roles: readonly Role[]): string {
  return `Запланированные разделы ${kind === 'packing' ? 'Packing Bot' : 'Invoice Bot'}:\n\n`
    + plannedSections(kind, roles).map(s => `• ${s}`).join('\n')
    + '\n\nЭто новая основа системы. Загрузка, расчёты и выпуск документов ещё не подключены.';
}
