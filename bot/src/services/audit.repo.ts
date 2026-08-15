import { supabase } from './supabase.js';
import { logger } from '../utils/logger.js';

export interface AuditEntry {
  actor_user_id?: string | null;
  action: string;
  target_type?: string | null;
  target_id?: string | null;
  payload?: Record<string, unknown> | null;
}

export async function audit(entry: AuditEntry): Promise<void> {
  const { error } = await supabase.from('audit_log').insert({
    actor_user_id: entry.actor_user_id ?? null,
    action: entry.action,
    target_type: entry.target_type ?? null,
    target_id: entry.target_id ?? null,
    payload: entry.payload ?? null,
  });
  if (error) {
    logger.error({ err: error, entry }, 'Failed to write audit_log');
  }
}
