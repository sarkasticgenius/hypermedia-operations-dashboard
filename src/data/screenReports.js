import { supabase } from '../supabaseClient.js';

// Only ever inserted by the screen-report-portal edge function (service role, no-login QR scan) -
// the dashboard side only ever reads/updates/deletes, same as workspace_devices. Asset/contractor
// info is resolved client-side against the already-cached Asset Inventory/Contractors lists
// (same pattern assetsInventory.js itself uses), not a PostgREST embed - one less query shape to
// keep in sync with RLS on two tables at once.
export async function listScreenReports() {
  const { data, error } = await supabase.from('screen_reports').select('*').order('created_at', { ascending: false });
  if (error) throw error;
  return data;
}

export async function updateScreenReport(id, fields) {
  const { data, error } = await supabase.from('screen_reports').update(fields).eq('id', id).select().single();
  if (error) throw error;
  return data;
}

export async function deleteScreenReport(id) {
  const { error } = await supabase.from('screen_reports').delete().eq('id', id);
  if (error) throw error;
}
