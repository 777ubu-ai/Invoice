import type { Pool } from 'pg';
import { parseRoles, type Role } from './access.js';

export class UserStore {
  constructor(private pool: Pool) {}

  async rolesFor(id: number): Promise<Role[]> {
    const result = await this.pool.query<{roles: string[]}>(
      'SELECT roles FROM packing_invoice_v2.users WHERE telegram_id = $1', [id],
    );
    const row = result.rows[0];
    return row ? parseRoles(row.roles.join(',')) : [];
  }

  async checkSchema(): Promise<void> {
    await this.pool.query('SELECT telegram_id, roles FROM packing_invoice_v2.users LIMIT 0');
  }
}
