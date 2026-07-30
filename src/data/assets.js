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

// Full deploy flow, ported from the original's saveDeploy(): validates quantity against
// available stock, auto-creates the destination Location if it doesn't already exist (typing a
// brand-new venue name silently creates it, same as the original), merges the quantity into the
// asset's per-location breakdown, moves stock from available -> on-site, and appends an
// append-only history row.
export async function deployAsset({ assetId, assetName, destinationName, qty, deployedBy, subAsset }) {
  const { data: asset, error: assetErr } = await supabase
    .from('assets').select('*, asset_locations(*)').eq('id', assetId).single();
  if (assetErr) throw assetErr;
  if (!qty || qty <= 0) throw new Error('Quantity must be greater than 0');
  if (qty > asset.stock_available) throw new Error(`Only ${asset.stock_available} available in warehouse`);

  const { data: existingLoc } = await supabase
    .from('locations').select('id,name').ilike('name', destinationName).maybeSingle();
  if (!existingLoc) {
    await supabase.from('locations').insert({
      name: destinationName, type: 'Installed', address: '',
      notes: `Auto-added from deployment by ${deployedBy || 'system'}`,
    });
  }

  const existingBreakdown = (asset.asset_locations || []).find((al) => al.location_name.toLowerCase() === destinationName.toLowerCase());
  if (existingBreakdown) {
    await supabase.from('asset_locations').update({ qty: existingBreakdown.qty + qty }).eq('id', existingBreakdown.id);
  } else {
    await supabase.from('asset_locations').insert({ asset_id: assetId, location_name: destinationName, qty });
  }

  await supabase.from('assets').update({
    stock_available: asset.stock_available - qty, stock_on_site: asset.stock_on_site + qty,
  }).eq('id', assetId);

  const { error } = await supabase.from('asset_assignments').insert({
    asset_id: assetId, asset_name: assetName, location_name: destinationName,
    qty, deployed_by: deployedBy || '', sub_asset: subAsset || null,
  });
  if (error) throw error;
}

// Targeted update for just the warranty/rental fields - used by Procurement & Delivery's order
// form, which lets an order write the warranty (or rental) details straight through to the asset
// it's for, without needing to fetch and resend the asset's other fields.
export async function updateAssetWarrantyOrRental(assetId, patch) {
  const { error } = await supabase.from('assets').update(patch).eq('id', assetId);
  if (error) throw error;
}

export async function quickSetAssetStatus(id, status) {
  const { error } = await supabase.from('assets').update({ status }).eq('id', id);
  if (error) throw error;
}

// Marks only `qty` units faulty, not the whole row's stock - splits that quantity out of the
// chosen bucket (warehouse or on-site) into a separate Faulty-status row for the same name/
// category (reusing one if it already exists, same "don't duplicate item metadata" idea Deploy
// already uses for its per-location breakdown), instead of flipping the entire asset to Faulty
// and losing track of how much good stock is actually left. If the quantity covers everything
// left in both buckets, this just flips the row's own status instead of splitting off a
// zero-stock sibling.
export async function markAssetFaulty(assetId, bucket, qty) {
  const field = bucket === 'onsite' ? 'stock_on_site' : 'stock_available';
  const otherField = bucket === 'onsite' ? 'stock_available' : 'stock_on_site';

  const { data: asset, error: fetchErr } = await supabase.from('assets').select('*').eq('id', assetId).single();
  if (fetchErr) throw fetchErr;
  const current = asset[field] || 0;
  if (!qty || qty <= 0) throw new Error('Quantity must be greater than 0');
  if (qty > current) throw new Error(`Only ${current} available in that bucket`);

  if (qty === current && (asset[otherField] || 0) === 0) {
    const { error } = await supabase.from('assets').update({ [field]: 0, status: 'Faulty' }).eq('id', assetId);
    if (error) throw error;
    return;
  }

  const { error: decErr } = await supabase.from('assets').update({ [field]: current - qty }).eq('id', assetId);
  if (decErr) throw decErr;

  const { data: existingFaulty } = await supabase.from('assets')
    .select('*').eq('name', asset.name).eq('category', asset.category).eq('status', 'Faulty').neq('id', assetId).maybeSingle();
  if (existingFaulty) {
    const { error } = await supabase.from('assets').update({ [field]: (existingFaulty[field] || 0) + qty }).eq('id', existingFaulty.id);
    if (error) throw error;
  } else {
    const { error } = await supabase.from('assets').insert({
      name: asset.name, category: asset.category, unit_price: asset.unit_price,
      stock_available: field === 'stock_available' ? qty : 0,
      stock_on_site: field === 'stock_on_site' ? qty : 0,
      status: 'Faulty', maintenance_contractor: asset.maintenance_contractor, notes: asset.notes,
    });
    if (error) throw error;
  }
}

export async function listAssetAssignments() {
  const { data, error } = await supabase.from('asset_assignments').select('*').order('date', { ascending: false });
  if (error) throw error;
  return data;
}
