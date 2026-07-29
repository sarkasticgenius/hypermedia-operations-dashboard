import { supabase } from '../supabaseClient.js';

export async function listLocations() {
  const { data, error } = await supabase
    .from('locations')
    .select('*, location_sub_assets(*)')
    .order('name')
    .range(0, 9999);
  if (error) throw error;
  return data;
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

export async function deleteLocation(id) {
  const { error } = await supabase.from('locations').delete().eq('id', id);
  if (error) throw error;
}

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
