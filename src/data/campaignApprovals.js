import { supabase } from '../supabaseClient.js';
import { STATE } from '../state.js';

export async function listApprovalsForClient(clientId) {
  const { data, error } = await supabase.from('campaign_approvals').select('*').eq('client_id', clientId);
  if (error) throw error;
  return data;
}

// Lazily creates a 'pending' row the first time a campaign shows up for a client - ignoreDuplicates
// means an existing row (approved or live) is left untouched rather than reset back to pending.
export async function upsertPendingApproval(contract, clientId, campaignName) {
  const { error } = await supabase.from('campaign_approvals')
    .upsert({ contract, client_id: clientId, campaign_name: campaignName, status: 'pending' }, { onConflict: 'contract', ignoreDuplicates: true });
  if (error) throw error;
}

// approved_by is sent explicitly (not just left to a default) because the client-side RLS policy
// checks `approved_by = auth.uid()` against the row being written, not auto-populated server-side.
export async function approveCampaign(id, comment) {
  const { error } = await supabase.from('campaign_approvals')
    .update({ status: 'approved', approved_by: STATE.user?.id || null, approved_at: new Date().toISOString(), comment: comment || null })
    .eq('id', id);
  if (error) throw error;
}

export async function markCampaignLive(id) {
  const { error } = await supabase.from('campaign_approvals')
    .update({ status: 'live', marked_live_by: STATE.user?.id || null, marked_live_at: new Date().toISOString() })
    .eq('id', id);
  if (error) throw error;
}
