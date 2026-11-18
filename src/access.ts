export const ROLES = ['owner', 'packing', 'reviewer', 'invoice', 'accountant'] as const;
export type Role = typeof ROLES[number];
export type BotKind = 'packing' | 'invoice';

export function parseRoles(value: string): Role[] {
  const roles = [...new Set(value.split(',').map(v => v.trim()))];
  if (!roles.length || roles.some(role => !ROLES.includes(role as Role))) {
    throw new Error(`Допустимые роли: ${ROLES.join(', ')}`);
  }
  return roles as Role[];
}

export function telegramId(value: string): number {
  if (!/^[1-9]\d*$/.test(value)) throw new Error('Нужен положительный Telegram user ID');
  const id = Number(value);
  if (!Number.isSafeInteger(id)) throw new Error('Telegram ID вне допустимого диапазона');
  return id;
}

export function canAccess(kind: BotKind, roles: readonly Role[]): boolean {
  if (roles.includes('owner')) return true;
  return kind === 'packing'
    ? roles.some(role => role === 'packing' || role === 'reviewer')
    : roles.some(role => role === 'invoice' || role === 'accountant');
}

export function canPrepareInvoice(roles: readonly Role[]): boolean {
  return roles.includes('owner') || roles.includes('invoice');
}

export function parseBotKind(value: string | undefined): BotKind {
  if (value !== 'packing' && value !== 'invoice') throw new Error('Укажите packing или invoice');
  return value;
}
