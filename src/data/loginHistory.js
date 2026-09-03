import { supabase } from '../supabaseClient.js';

export async function listLoginHistory(limit) {
  const { data, error } = await supabase
    .from('login_history')
    .select('*')
    .order('ts', { ascending: false })
    .limit(limit || 500);
  if (error) throw error;
  return data;
}
