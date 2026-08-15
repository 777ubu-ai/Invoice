import { supabase } from './supabase.js';

export interface HelpRequest {
  id: string;
  from_user_id: string;
  to_user_id: string;
  invoice_id: string | null;
  description: string;
  status: 'PENDING' | 'RESOLVED';
  response: string | null;
  created_at: string;
  resolved_at: string | null;
}

export async function create(input: Omit<HelpRequest, 'id' | 'status' | 'response' | 'created_at' | 'resolved_at'>): Promise<HelpRequest> {
  const { data, error } = await supabase
    .from('help_requests')
    .insert({
      from_user_id: input.from_user_id,
      to_user_id: input.to_user_id,
      invoice_id: input.invoice_id,
      description: input.description,
    })
    .select('*')
    .single();
  if (error) throw error;
  return data as HelpRequest;
}

export async function listPendingFor(userId: string): Promise<HelpRequest[]> {
  const { data, error } = await supabase
    .from('help_requests')
    .select('*')
    .eq('to_user_id', userId)
    .eq('status', 'PENDING')
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data ?? []) as HelpRequest[];
}
