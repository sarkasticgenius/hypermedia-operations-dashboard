import { supabase } from '../supabaseClient.js';

export async function listSyncLogs(integration, limit = 30) {
  const { data, error } = await supabase
    .from('integration_sync_logs')
    .select('*')
    .eq('integration', integration)
    .order('synced_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data;
}
