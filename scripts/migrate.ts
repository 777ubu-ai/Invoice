import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { readDatabaseUrl } from '../src/config.js';

async function main() {
  const pool = new Pool({ connectionString: readDatabaseUrl(process.env), connectionTimeoutMillis: 10_000 });
  try {
    const sql = await readFile(new URL('../migrations/001_foundation.sql', import.meta.url), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(481701)');
      await client.query(sql);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
    console.log('Схема packing_invoice_v2 подготовлена. Старые таблицы не изменялись.');
  } finally { await pool.end(); }
}
main().catch(() => { console.error('Миграция не выполнена. Проверьте новую БД и права подключения.'); process.exitCode = 1; });
