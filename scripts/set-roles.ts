import 'dotenv/config';
import { userInfo } from 'node:os';
import { Pool } from 'pg';
import { telegramId, parseRoles } from '../src/access.js';
import { readDatabaseUrl } from '../src/config.js';
import { setRoles } from '../src/roles-admin.js';

async function main() {
  const id = telegramId(process.argv[2] ?? '');
  const roles = parseRoles(process.argv[3] ?? '');
  const pool = new Pool({ connectionString: readDatabaseUrl(process.env), connectionTimeoutMillis: 10_000 });
  try {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await setRoles(client, id, roles, `server-admin:${userInfo().username}`);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
    console.log(`Роли пользователя ${id}: ${roles.join(', ')}. Изменение сохранено в журнале.`);
  } finally { await pool.end(); }
}
main().catch(() => {
  console.error('Права не изменены. Формат: npm run user:set-roles -- TELEGRAM_ID packing,reviewer. Проверьте БД и допустимые роли.');
  process.exitCode = 1;
});
