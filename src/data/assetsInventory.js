import { supabase } from '../supabaseClient.js';
import { ensureNetwork } from './networks.js';

const PAGE_SIZE = 1000;

export async function listAssetInventory() {
  // Supabase's project-wide "Max Rows" setting hard-caps any single request (default 1000)
  // regardless of what .range() asks for, and this table (one row per physical screen) regularly
  // has 2,000+ - so page through it PAGE_SIZE rows at a time instead of one big request.
  const all = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from('asset_inventory')
      .select('*, asset_inventory_networks(network_id, networks(name))')
      .order('name')
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw error;
    all.push(...data);
    if (data.length < PAGE_SIZE) break;
  }
  return all.map((row) => ({
    ...row,
    networkNames: (row.asset_inventory_networks || []).map((n) => n.networks?.name).filter(Boolean),
  }));
}

function toPayload(row) {
  return {
    source_asset_id: row.sourceAssetId ?? null,
    name: row.name, venue: row.venue || null, location: row.location || null,
    category: row.category || null, pdooh_ready: !!row.pdoohReady, format: row.format || null,
    width: row.width || null, height: row.height || null, screens: row.screens || null,
    faces: row.faces || null, special_render: row.specialRender || null,
    anydesk_id: row.anydeskId || null, teamviewer_id: row.teamviewerId || null,
    sensor_id: row.sensorId || null, lat: row.lat || null, lng: row.lng || null,
    multiplier: row.multiplier || null, position: row.position || null,
    player_box_id: row.playerBoxId || null, ad_duration: row.adDuration || null,
    player_type: row.playerType || null, managed_by_hm: !!row.managedByHM,
    source: row.source || null, contractor_id: row.contractorId || null,
  };
}

export async function saveAssetInventory(row, networkNames) {
  const payload = toPayload(row);
  let saved;
  if (row.id) {
    const { data, error } = await supabase.from('asset_inventory').update(payload).eq('id', row.id).select().single();
    if (error) throw error;
    saved = data;
  } else {
    const { data, error } = await supabase.from('asset_inventory').insert(payload).select().single();
    if (error) throw error;
    saved = data;
  }
  if (networkNames) {
    await supabase.from('asset_inventory_networks').delete().eq('asset_inventory_id', saved.id);
    const nets = await Promise.all(networkNames.filter(Boolean).map((n) => ensureNetwork(n)));
    const rows = nets.filter(Boolean).map((n) => ({ asset_inventory_id: saved.id, network_id: n.id }));
    if (rows.length) await supabase.from('asset_inventory_networks').insert(rows);
  }
  return saved;
}

export async function bulkUpdateAssetInventory(ids, patch) {
  const payload = toPayload(patch);
  Object.keys(payload).forEach((k) => { if (payload[k] == null) delete payload[k]; });
  const { error } = await supabase.from('asset_inventory').update(payload).in('id', ids);
  if (error) throw error;
}

export async function deleteAssetInventory(id) {
  const { error } = await supabase.from('asset_inventory').delete().eq('id', id);
  if (error) throw error;
}
