import { supabase } from './supabase.js';
import type { InvoiceState } from './api.types.js';

export async function listAssignedActive(userId: string): Promise<InvoiceState[]> {
  const { data, error } = await supabase
    .from('invoices')
    .select('*')
    .eq('assigned_to', userId)
    .in('status', ['UPLOADED', 'PROCESSING', 'REVIEW', 'FAILED'])
    .order('created_at', { ascending: false })
    .limit(20);
  if (error) throw error;
  return (data ?? []) as InvoiceState[];
}

export async function listAssignedHistory(userId: string): Promise<InvoiceState[]> {
  const { data, error } = await supabase
    .from('invoices')
    .select('*')
    .eq('assigned_to', userId)
    .in('status', ['APPROVED', 'CANCELED'])
    .order('updated_at', { ascending: false })
    .limit(20);
  if (error) throw error;
  return (data ?? []) as InvoiceState[];
}

export async function listTeamActive(managerId: string): Promise<InvoiceState[]> {
  const { data: members } = await supabase
    .from('telegram_users')
    .select('id')
    .eq('manager_id', managerId);
  const ids = (members ?? []).map((m) => m.id);
  if (ids.length === 0) return [];
  const { data, error } = await supabase
    .from('invoices')
    .select('*')
    .in('assigned_to', ids)
    .in('status', ['UPLOADED', 'PROCESSING', 'REVIEW', 'FAILED'])
    .order('created_at', { ascending: false })
    .limit(50);
  if (error) throw error;
  return (data ?? []) as InvoiceState[];
}

export async function listAll(limit = 50): Promise<InvoiceState[]> {
  const { data, error } = await supabase
    .from('invoices')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []) as InvoiceState[];
}

export async function reassign(invoiceId: string, newAssignee: string, from: string): Promise<void> {
  const { error } = await supabase
    .from('invoices')
    .update({
      assigned_to: newAssignee,
      reassigned_from: from,
      updated_at: new Date().toISOString(),
    })
    .eq('id', invoiceId);
  if (error) throw error;
}

export async function getById(invoiceId: string): Promise<InvoiceState | null> {
  const { data, error } = await supabase
    .from('invoices')
    .select('*')
    .eq('id', invoiceId)
    .maybeSingle();
  if (error) throw error;
  return (data as InvoiceState | null) ?? null;
}
