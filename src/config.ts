import { telegramId, type BotKind } from './access.js';

export function readConfig(env: NodeJS.ProcessEnv, kind: BotKind) {
  const key = kind === 'packing' ? 'PACKING_BOT_TOKEN' : 'INVOICE_BOT_TOKEN';
  const token = env[key]?.trim();
  if (!token || !/^\d+:[A-Za-z0-9_-]+$/.test(token)) throw new Error(`Заполните ${key}`);
  if (env.PACKING_BOT_TOKEN?.trim() === env.INVOICE_BOT_TOKEN?.trim()) {
    throw new Error('Для двух ботов нужны разные токены');
  }
  const databaseUrl = readDatabaseUrl(env);
  const ownerIds = (env.OWNER_TELEGRAM_IDS ?? '').split(',').map(v => v.trim()).filter(Boolean).map(telegramId);
  if (!ownerIds.length) throw new Error('Заполните OWNER_TELEGRAM_IDS');
  return { token, databaseUrl, ownerIds };
}

export function readDatabaseUrl(env: NodeJS.ProcessEnv): string {
  const value = env.DATABASE_URL;
  if (!value) throw new Error('Заполните DATABASE_URL');
  const url = new URL(value);
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error('Нужна PostgreSQL DATABASE_URL');
  return value;
}
