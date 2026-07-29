import { supabase } from '../supabaseClient.js';

export async function listSimCards() {
  const { data, error } = await supabase.from('sim_cards').select('*').order('sim_number').range(0, 9999);
  if (error) throw error;
  return data;
}

export async function saveSimCard(row) {
  const payload = {
    sim_number: row.simNumber || null, iccid: row.iccid || null, carrier: row.carrier || null,
    data_plan: row.dataPlan || null, billing_cost: row.billingCost || null,
    data_allocation_gb: row.dataAllocationGB || null, procured_date: row.procuredDate || null,
    active_since: row.activeSince || null, notes: row.notes || null, status: row.status || 'In Stock',
  };
  if (row.id) {
    const { data, error } = await supabase.from('sim_cards').update(payload).eq('id', row.id).select().single();
    if (error) throw error;
    return data;
  }
  const { data, error } = await supabase.from('sim_cards').insert(payload).select().single();
  if (error) throw error;
  return data;
}

export async function deploySimCard(id, { locationId, locationName, assetInvId, assetInvLabel }) {
  const { data, error } = await supabase.from('sim_cards').update({
    status: 'Deployed', deployed_location_id: locationId || null, deployed_location_name: locationName || null,
    deployed_asset_inv_id: assetInvId || null, deployed_asset_inv_label: assetInvLabel || null,
    deployed_date: new Date().toISOString().slice(0, 10),
  }).eq('id', id).select().single();
  if (error) throw error;
  return data;
}

export async function deleteSimCard(id) {
  const { error } = await supabase.from('sim_cards').delete().eq('id', id);
  if (error) throw error;
}
