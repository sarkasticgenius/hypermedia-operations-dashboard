import { supabase } from '../supabaseClient.js';
import { softDeleteRow, restoreRow, permanentlyDeleteRow, listDeletedRows } from './softDelete.js';
import { fetchAllPages } from '../lib/pagedFetch.js';

export async function listLocations() {
  return fetchAllPages((withCount) => supabase
    .from('locations')
    .select('*, location_sub_assets(*)', withCount ? { count: 'exact' } : undefined)
    .is('deleted_at', null)
    .order('name'));
}

export async function saveLocation(row) {
  const payload = {
    name: row.name, type: row.type || 'Planned', address: row.address || null,
    emirate: row.emirate || null, notes: row.notes || null, chain: row.chain || null,
    is_combined: !!row.isCombined, combined_members: row.combinedMembers || [],
    manual_asset_inventory_ids: row.manualAssetInventoryIds || [],
  };
  if (row.id) {
    const { data, error } = await supabase.from('locations').update(payload).eq('id', row.id).select().single();
    if (error) throw error;
    return data;
  }
  const { data, error } = await supabase.from('locations').insert(payload).select().single();
  if (error) throw error;
  return data;
}

export async function deleteLocation(id) { return softDeleteRow('locations', id); }
export async function restoreLocation(id) { return restoreRow('locations', id); }
export async function permanentlyDeleteLocation(id) { return permanentlyDeleteRow('locations', id); }
export async function listDeletedLocations() { return listDeletedRows('locations'); }

export async function saveSubAsset(row) {
  const payload = { location_id: row.locationId, name: row.name, status: row.status || 'Offline', notes: row.notes || null, source: row.source || null };
  if (row.id) {
    const { error } = await supabase.from('location_sub_assets').update(payload).eq('id', row.id);
    if (error) throw error;
    return;
  }
  const { error } = await supabase.from('location_sub_assets').insert(payload);
  if (error) throw error;
}

export async function deleteSubAsset(id) {
  const { error } = await supabase.from('location_sub_assets').delete().eq('id', id);
  if (error) throw error;
}

export async function setManualAssetInventoryIds(locationId, ids) {
  const { error } = await supabase.from('locations').update({ manual_asset_inventory_ids: ids }).eq('id', locationId);
  if (error) throw error;
}

export async function combineLocations(name, memberIds) {
  const { data, error } = await supabase.from('locations').insert({
    name, type: 'Installed', address: '', notes: 'Combined view of selected locations',
    is_combined: true, combined_members: memberIds,
  }).select().single();
  if (error) throw error;
  return data;
}
