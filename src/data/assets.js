import { supabase } from '../supabaseClient.js';

export async function listAssets() {
  const { data, error } = await supabase.from('assets').select('*, asset_locations(*)').order('name').range(0, 9999);
  if (error) throw error;
  return data;
}

export async function saveAsset(row) {
  const payload = {
    name: row.name, category: row.category, unit_price: row.unitPrice || 0,
    stock_available: row.stockAvailable || 0, stock_on_site: row.stockOnSite || 0,
    serial_number: row.serialNumber || null, warranty_expiry: row.warrantyExpiry || null,
    date_of_rent: row.dateOfRent || null, maintenance_location: row.maintenanceLocation || null,
    maintenance_contractor: row.maintenanceContractor || null, status: row.status || 'Active',
    notes: row.notes || null,
  };
  if (row.id) {
    const { data, error } = await supabase.from('assets').update(payload).eq('id', row.id).select().single();
    if (error) throw error;
    return data;
  }
  const { data, error } = await supabase.from('assets').insert(payload).select().single();
  if (error) throw error;
  return data;
}

export async function deleteAsset(id) {
  const { error } = await supabase.from('assets').delete().eq('id', id);
  if (error) throw error;
}

export async function setAssetLocations(assetId, breakdown) {
  await supabase.from('asset_locations').delete().eq('asset_id', assetId);
  const rows = (breakdown || []).filter((b) => b.name && b.qty).map((b) => ({
    asset_id: assetId, location_name: b.name, qty: b.qty,
  }));
  if (rows.length) {
    const { error } = await supabase.from('asset_locations').insert(rows);
    if (error) throw error;
  }
}

export async function deployAsset({ assetId, assetName, locationName, qty, deployedBy, subAsset }) {
  const { error } = await supabase.from('asset_assignments').insert({
    asset_id: assetId, asset_name: assetName, location_name: locationName,
    qty, deployed_by: deployedBy || '', sub_asset: subAsset || null,
  });
  if (error) throw error;
}

export async function listAssetAssignments() {
  const { data, error } = await supabase.from('asset_assignments').select('*').order('date', { ascending: false });
  if (error) throw error;
  return data;
}
