import { supabase } from '../supabaseClient.js';
import { softDeleteRow, restoreRow, permanentlyDeleteRow, listDeletedRows } from './softDelete.js';

export async function listSimCards() {
  const { data, error } = await supabase.from('sim_cards').select('*').is('deleted_at', null).order('sim_number').range(0, 9999);
  if (error) throw error;
  return data;
}

export async function saveSimCard(row) {
  const payload = {
    sim_number: row.simNumber || null, iccid: row.iccid || null, carrier: row.carrier || null,
    data_plan: row.dataPlan || null, billing_cost: row.billingCost || null,
    data_allocation_gb: row.dataAllocationGB || null, procured_date: row.procuredDate || null,
    active_since: row.activeSince || null, notes: row.notes || null, status: row.status || 'Spare',
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

// No double-booking a screen: if another SIM is already Deployed at the exact
// same venue+screen, it's automatically returned to spare stock first.
export async function deploySimCard(id, { locationId, locationName, assetInvId, assetInvLabel }) {
  const { data: conflicts } = await supabase
    .from('sim_cards')
    .select('id')
    .eq('status', 'Deployed')
    .eq('deployed_location_name', locationName)
    .eq(assetInvId ? 'deployed_asset_inv_id' : 'deployed_location_name', assetInvId || locationName)
    .neq('id', id);
  let autoReturned = 0;
  if (conflicts?.length) {
    await supabase.from('sim_cards').update({
      status: 'Spare', deployed_location_id: null, deployed_location_name: null,
      deployed_asset_inv_id: null, deployed_asset_inv_label: null, deployed_date: null,
    }).in('id', conflicts.map((c) => c.id));
    autoReturned = conflicts.length;
  }
  const { data, error } = await supabase.from('sim_cards').update({
    status: 'Deployed', deployed_location_id: locationId || null, deployed_location_name: locationName || null,
    deployed_asset_inv_id: assetInvId || null, deployed_asset_inv_label: assetInvLabel || null,
    deployed_date: new Date().toISOString().slice(0, 10),
  }).eq('id', id).select().single();
  if (error) throw error;
  return { ...data, autoReturned };
}

export async function deleteSimCard(id) { return softDeleteRow('sim_cards', id); }
export async function restoreSimCard(id) { return restoreRow('sim_cards', id); }
export async function permanentlyDeleteSimCard(id) { return permanentlyDeleteRow('sim_cards', id); }
export async function listDeletedSimCards() { return listDeletedRows('sim_cards'); }

export async function returnSimToStock(id) {
  const { error } = await supabase.from('sim_cards').update({
    status: 'Spare', deployed_location_id: null, deployed_location_name: null,
    deployed_asset_inv_id: null, deployed_asset_inv_label: null, deployed_date: null,
  }).eq('id', id);
  if (error) throw error;
}

export async function markMismatchResolved(id) {
  const { error } = await supabase.from('sim_cards').update({ has_mismatch: false }).eq('id', id);
  if (error) throw error;
}

// Two SIMs at the same venue but different screens are NOT duplicates - only
// same venue+screen (or both venue-level with no screen) counts. Computed live
// on every render (unlike has_mismatch, a persisted one-time import flag) so
// it self-clears the moment a SIM moves - ported from the original's
// simLocationKey()/simLocationDuplicateCounts()/isDuplicateLocationSim().
export function simLocationKey(s) {
  if (s.status !== 'Deployed' || !s.deployed_location_name) return null;
  return `${s.deployed_location_name}||${s.deployed_asset_inv_id || s.deployed_asset_inv_label || ''}`.toLowerCase().trim();
}

export function simLocationDuplicateCounts(simCards) {
  const counts = new Map();
  for (const s of simCards) {
    const key = simLocationKey(s);
    if (!key) continue;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return counts;
}

export function isDuplicateLocationSim(s, counts) {
  const key = simLocationKey(s);
  if (!key) return false;
  return (counts.get(key) || 0) > 1;
}
