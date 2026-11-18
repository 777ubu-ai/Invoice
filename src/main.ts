import 'dotenv/config';
import { Pool } from 'pg';
import { parseBotKind } from './access.js';
import { readConfig } from './config.js';
import { createBot } from './bot.js';
import { UserStore } from './store.js';
import { InvoiceStore } from './invoice-draft.js';
import { loadCompanyProfile } from './company-profile.js';

async function main() {
  const kind = parseBotKind(process.argv[2]);
  const config = readConfig(process.env, kind);
  const pool = new Pool({ connectionString: config.databaseUrl, connectionTimeoutMillis: 10_000 });
  pool.on('error', () => console.error('Ошибка подключения к базе данных.'));
  const store = new UserStore(pool);
  let bot: ReturnType<typeof createBot> | undefined;
  try {
    await store.checkSchema();
    bot = createBot(config.token, kind, store, config.ownerIds, process.env.TARIFF_GRID_PATH, new InvoiceStore(pool), () => loadCompanyProfile(process.env.BUYER_PROFILE_PATH ?? ''));
    bot.catch(() => console.error('Не удалось обработать обновление. Проверьте подключение и права.'));
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      process.once(signal, () => { if (bot?.isRunning()) bot.stop(); });
    }
    // Startup does not migrate any database or discard pending Telegram updates.
    await bot.start({ onStart: () => console.log(`${kind} bot started`) });
  } finally {
    await pool.end();
  }
}

main().catch(() => {
  // Do not print tokens, connection strings, incoming files, or raw provider errors.
  console.error('Запуск не выполнен. Проверьте переменные окружения, миграцию новой БД и доступность Telegram.');
  process.exitCode = 1;
});
