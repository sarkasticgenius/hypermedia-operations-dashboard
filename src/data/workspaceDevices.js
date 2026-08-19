import { supabase } from '../supabaseClient.js';

// No soft-delete here (unlike most tables) - these rows are agent-reported telemetry, re-created
// automatically on the device's next check-in, not user-authored records worth a Recycle Bin.
export async function listWorkspaceDevices() {
  const { data, error } = await supabase.from('workspace_devices').select('*').order('hostname');
  if (error) throw error;
  return data;
}

export async function updateWorkspaceDevice(id, fields) {
  const { data, error } = await supabase.from('workspace_devices').update(fields).eq('id', id).select().single();
  if (error) throw error;
  return data;
}

export async function deleteWorkspaceDevice(id) {
  const { error } = await supabase.from('workspace_devices').delete().eq('id', id);
  if (error) throw error;
}
