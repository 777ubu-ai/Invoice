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

  async setInvoiceAccess(id:number, role:'invoice'|'accountant'|'remove', actor:number):Promise<Role[]> {
    const c=await this.pool.connect();
    try {
      await c.query('BEGIN');await c.query('SELECT pg_advisory_xact_lock($1::bigint)',[id]);
      const result=await c.query<{roles:string[]}>('SELECT roles FROM packing_invoice_v2.users WHERE telegram_id=$1',[id]);
      const before=result.rows[0]?.roles ?? [];
      if(before.includes('owner'))throw new Error('Нельзя менять права руководителя через это меню.');
      const after=[...before.filter(r=>r!=='invoice'&&r!=='accountant'),...(role==='remove'?[]:[role])];
      if(after.length)await c.query(`INSERT INTO packing_invoice_v2.users(telegram_id,roles) VALUES($1,$2) ON CONFLICT(telegram_id) DO UPDATE SET roles=excluded.roles,updated_at=now()`,[id,after]);
      else await c.query('DELETE FROM packing_invoice_v2.users WHERE telegram_id=$1',[id]);
      await c.query('INSERT INTO packing_invoice_v2.role_changes(telegram_id,previous_roles,new_roles,actor) VALUES($1,$2,$3,$4)',[id,before,after,`telegram:${actor}`]);
      await c.query('COMMIT');return after as Role[];
    }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
  }

  async checkSchema(): Promise<void> {
    await this.pool.query('SELECT telegram_id, roles FROM packing_invoice_v2.users LIMIT 0');
  }
}
