import { supabase } from '../supabaseClient.js';

export async function listAuditLog(limit) {
  const { data, error } = await supabase
    .from('audit_log')
    .select('*')
    .order('ts', { ascending: false })
    .limit(limit || 500);
  if (error) throw error;
  return data;
}
