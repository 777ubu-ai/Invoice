import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { readDatabaseUrl } from '../src/config.js';

async function main() {
  const pool = new Pool({ connectionString: readDatabaseUrl(process.env), connectionTimeoutMillis: 10_000 });
  try {
    const migrations = ['001_foundation.sql', '002_invoice_drafts.sql', '003_buyer_details.sql', '004_packing_jobs.sql', '005_issued_files.sql', '006_commercial_workflow.sql'];
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(481701)');
      for (const name of migrations) {
        await client.query(await readFile(new URL(`../migrations/${name}`, import.meta.url), 'utf8'));
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
    console.log('Схема packing_invoice_v2 подготовлена. Старые таблицы не изменялись.');
  } finally { await pool.end(); }
}
main().catch(() => { console.error('Миграция не выполнена. Проверьте новую БД и права подключения.'); process.exitCode = 1; });
