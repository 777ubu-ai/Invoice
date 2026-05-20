export type Role = 'OWNER' | 'MANAGER' | 'OPERATOR';

export interface TelegramUser {
  id: string;
  telegram_user_id: number;
  telegram_username: string | null;
  full_name: string;
  role: Role;
  team_name: string | null;
  manager_id: string | null;
  client_access: string[];
  added_by: string | null;
  added_at: string;
  last_active: string | null;
  is_active: boolean;
  language: string;
  invoices_total: number;
  invoices_this_month: number;
  avg_confidence: number | null;
  created_at: string;
  updated_at: string;
}
