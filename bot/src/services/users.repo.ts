import { supabase } from './supabase.js';
import type { Role, TelegramUser } from '../types/user.js';

export async function findByTelegramId(telegramUserId: number): Promise<TelegramUser | null> {
  const { data, error } = await supabase
    .from('telegram_users')
    .select('*')
    .eq('telegram_user_id', telegramUserId)
    .maybeSingle();
  if (error) throw error;
  return data as TelegramUser | null;
}

export async function findByUsername(username: string): Promise<TelegramUser | null> {
  const normalized = username.replace(/^@/, '').toLowerCase();
  const { data, error } = await supabase
    .from('telegram_users')
    .select('*')
    .ilike('telegram_username', normalized)
    .maybeSingle();
  if (error) throw error;
  return data as TelegramUser | null;
}

export async function touchLastActive(userId: string): Promise<void> {
  await supabase
    .from('telegram_users')
    .update({ last_active: new Date().toISOString() })
    .eq('id', userId);
}

export interface CreateUserInput {
  telegram_user_id?: number | null;
  telegram_username: string;
  full_name: string;
  role: Role;
  team_name?: string | null;
  manager_id?: string | null;
  client_access?: string[];
  added_by?: string | null;
}

export async function createUser(input: CreateUserInput): Promise<TelegramUser> {
  const row = {
    telegram_user_id: input.telegram_user_id ?? null,
    telegram_username: input.telegram_username.replace(/^@/, '').toLowerCase(),
    full_name: input.full_name,
    role: input.role,
    team_name: input.team_name ?? null,
    manager_id: input.manager_id ?? null,
    client_access: input.client_access ?? [],
    added_by: input.added_by ?? null,
  };

  const { data, error } = await supabase
    .from('telegram_users')
    .insert(row)
    .select('*')
    .single();
  if (error) throw error;
  return data as TelegramUser;
}

export async function bindTelegramId(userId: string, telegramUserId: number): Promise<void> {
  const { error } = await supabase
    .from('telegram_users')
    .update({ telegram_user_id: telegramUserId })
    .eq('id', userId);
  if (error) throw error;
}

export async function listOperatorsByManager(managerId: string): Promise<TelegramUser[]> {
  const { data, error } = await supabase
    .from('telegram_users')
    .select('*')
    .eq('manager_id', managerId)
    .eq('is_active', true)
    .order('full_name');
  if (error) throw error;
  return (data ?? []) as TelegramUser[];
}

export async function listAllUsers(): Promise<TelegramUser[]> {
  const { data, error } = await supabase
    .from('telegram_users')
    .select('*')
    .order('role')
    .order('full_name');
  if (error) throw error;
  return (data ?? []) as TelegramUser[];
}

export async function deactivateUser(userId: string): Promise<void> {
  const { error } = await supabase
    .from('telegram_users')
    .update({ is_active: false })
    .eq('id', userId);
  if (error) throw error;
}
