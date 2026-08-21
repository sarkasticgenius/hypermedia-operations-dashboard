import { supabase } from '../supabaseClient.js';

// hostname is unique, so a hard delete here is only ever cosmetic if that PC's agent is still
// installed and running - it just re-creates the same row on its next check-in, with no way to
// tell "this is a device someone removed on purpose" from "this is a genuinely new device". So
// removing a device is a soft-delete (removed_at) instead: hidden from the normal list below, but
// the row (and hostname) stays put so a check-in after removal can be recognized as exactly that -
// see listGhostWorkspaceDevices.
export async function listWorkspaceDevices() {
  const { data, error } = await supabase.from('workspace_devices').select('*').is('removed_at', null).order('hostname');
  if (error) throw error;
  return data;
}

// Removed-but-still-checking-in devices: an admin took it out of the directory, but its agent (and
// therefore its scheduled tasks) are still running on the actual PC and keep reporting - the one
// thing a plain "removed_at is set" can't tell you on its own is whether that's happened yet, hence
// the last_seen > removed_at filter.
export async function listGhostWorkspaceDevices() {
  const { data, error } = await supabase.from('workspace_devices').select('*').not('removed_at', 'is', null).order('last_seen', { ascending: false });
  if (error) throw error;
  return (data || []).filter((d) => d.last_seen && d.removed_at && new Date(d.last_seen) > new Date(d.removed_at));
}

export async function updateWorkspaceDevice(id, fields) {
  const { data, error } = await supabase.from('workspace_devices').update(fields).eq('id', id).select().single();
  if (error) throw error;
  return data;
}

export async function deleteWorkspaceDevice(id) {
  const { error } = await supabase.from('workspace_devices').update({ removed_at: new Date().toISOString() }).eq('id', id);
  if (error) throw error;
}

// Un-removes a device (e.g. it was taken out by mistake, or the admin decided to keep tracking a
// ghost instead of uninstalling it) - brings it back into the normal directory list.
export async function restoreWorkspaceDevice(id) {
  const { error } = await supabase.from('workspace_devices').update({ removed_at: null }).eq('id', id);
  if (error) throw error;
}

// The real, permanent delete - only reachable from the ghost-devices banner, for a device whose
// agent has actually been uninstalled (or that's simply not coming back) and shouldn't be tracked
// as a ghost forever. Frees the hostname too, so a genuinely new PC reusing that name isn't blocked.
export async function permanentlyDeleteWorkspaceDevice(id) {
  const { error } = await supabase.from('workspace_devices').delete().eq('id', id);
  if (error) throw error;
}
