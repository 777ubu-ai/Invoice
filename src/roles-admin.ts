import type { Role } from './access.js';

export interface RoleClient {
  query(sql: string, values?: unknown[]): Promise<{ rows: { roles: string[] }[] }>;
}

// Caller owns the transaction. Executed only by the server administrator CLI.
export async function setRoles(client: RoleClient, id: number, roles: Role[], actor: string) {
  await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [id]);
  const before = await client.query('SELECT roles FROM packing_invoice_v2.users WHERE telegram_id = $1', [id]);
  await client.query(`INSERT INTO packing_invoice_v2.users (telegram_id, roles) VALUES ($1, $2)
    ON CONFLICT (telegram_id) DO UPDATE SET roles = excluded.roles, updated_at = now()`, [id, roles]);
  await client.query(`INSERT INTO packing_invoice_v2.role_changes (telegram_id, previous_roles, new_roles, actor)
    VALUES ($1, $2, $3, $4)`, [id, before.rows[0]?.roles ?? null, roles, actor]);
}
