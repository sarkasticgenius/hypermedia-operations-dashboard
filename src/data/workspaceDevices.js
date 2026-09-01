import { supabase } from '../supabaseClient.js';

// hostname is unique, so a hard delete here is only ever cosmetic if that PC's agent is still
// installed and running - it just re-creates the same row on its next check-in, with no way to
// tell "this is a device someone removed on purpose" from "this is a genuinely new device". So
// removing a device is a soft-delete (removed_at) instead: hidden from the normal list below, but
// the row (and hostname) stays put so a check-in after removal can be recognized as exactly that -
// see listGhostWorkspaceDevices.
// Every column EXCEPT software and components, which are only ever read inside one device's Details
// modal (see componentsHtml/softwareHtml in workspaceDirectory.js) and are never shown in the table.
// select('*') pulled them for all 572 devices on every load: 1,766 kB of row data, of which
// `software` alone was 1,178 kB - two thirds of the payload, for a field the list does not render.
// Measured 1,574 ms just for this request on a fast office connection; these PCs' admins are on far
// slower ones. Fetched on demand instead by getWorkspaceDeviceDetail below, for the single device
// actually being looked at.
//
// Spelled out rather than expressed as a negation because PostgREST has no "all except" syntax. A
// column added to the table and not added here simply will not reach the list - which is the right
// default for a payload this size, but it does mean a new list-rendered field needs adding here too.
const LIST_COLUMNS = [
  'id', 'hostname', 'location', 'ip_address', 'anydesk_id', 'os_name', 'os_version',
  'logged_in_user', 'agent_version', 'agent_shell_version', 'notes', 'last_seen', 'created_at',
  'teamviewer_id', 'other_remote_ids', 'volumes', 'antivirus', 'problems', 'sim_card_id',
  'network_bytes_total', 'data_used_mb_period', 'pending_command', 'last_command_output',
  'last_command_at', 'broadsign_player_id', 'grassfish_box_id', 'data_used_mb_last_24h',
  'data_usage_computed_at', 'du_phone_number', 'du_data_used_gb', 'du_data_left_gb',
  'du_data_total_gb', 'du_scraped_at', 'force_checkin_requested', 'removed_at',
  'ignored_problem_types', 'offline_alerted_at', 'du_scrape_attempted_at', 'du_scrape_note',
  'du_scrape_outcome', 'updates_disabled', 'updates_pinned_version', 'anydesk_password_set_at',
  'anydesk_installs', 'du_stale_alerted_at', 'problems_last_alerted',
].join(', ');

// The two heavy columns the list deliberately skips, for one device. Keyed per device by the caller
// so opening one Details modal never re-fetches another's.
export async function getWorkspaceDeviceSoftware(id) {
  const { data, error } = await supabase.from('workspace_devices')
    .select('id, software, components').eq('id', id).single();
  if (error) throw error;
  return data;
}

export async function listWorkspaceDevices() {
  const { data, error } = await supabase.from('workspace_devices').select(LIST_COLUMNS).is('removed_at', null).order('hostname');
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
