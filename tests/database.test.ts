import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { setRoles, type RoleClient } from '../src/roles-admin.js';
import { UserStore } from '../src/store.js';
import type { Pool } from 'pg';

test('fresh schema is repeatable, preserves legacy data, and role changes are shared and audited', async () => {
  const db = new PGlite();
  try {
    await db.exec('CREATE TABLE legacy_invoices (id int PRIMARY KEY, amount numeric); INSERT INTO legacy_invoices VALUES (1, 125.50)');
    const sql = await readFile(new URL('../migrations/001_foundation.sql', import.meta.url), 'utf8');
    await db.exec(sql);
    await db.exec(sql);
    const legacy = await db.query('SELECT amount FROM legacy_invoices WHERE id = 1');
    assert.equal(legacy.rows.length, 1);
    assert.equal(String((legacy.rows[0] as {amount: string}).amount), '125.50');

    const client = { query: async (sql: string, values?: unknown[]) => db.query(sql, values) };
    const store = new UserStore(client as unknown as Pool);
    await store.checkSchema();
    assert.deepEqual(await store.rolesFor(42), []);
    await db.exec('BEGIN');
    await setRoles(client as RoleClient, 42, ['packing', 'reviewer'], 'test-admin');
    await db.exec('COMMIT');
    assert.deepEqual(await store.rolesFor(42), ['packing', 'reviewer']);
    await db.exec('BEGIN');
    await setRoles(client as RoleClient, 42, ['accountant'], 'test-admin');
    await db.exec('COMMIT');
    assert.deepEqual(await store.rolesFor(42), ['accountant']);
    const audit = await db.query<{previous_roles: string[] | null; new_roles: string[]}>(
      'SELECT previous_roles, new_roles FROM packing_invoice_v2.role_changes ORDER BY id',
    );
    assert.deepEqual(audit.rows, [
      { previous_roles: null, new_roles: ['packing', 'reviewer'] },
      { previous_roles: ['packing', 'reviewer'], new_roles: ['accountant'] },
    ]);
    await assert.rejects(db.query('INSERT INTO packing_invoice_v2.users VALUES ($1, $2, now())', [43, ['administrator']]));
    await assert.rejects(db.query('INSERT INTO packing_invoice_v2.users VALUES ($1, $2, now())', [43, []]));
  } finally { await db.close(); }
});
