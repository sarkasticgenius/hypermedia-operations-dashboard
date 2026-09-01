import { supabase } from '../supabaseClient.js';
import { ensureNetwork } from './networks.js';
import { softDeleteRow, restoreRow, permanentlyDeleteRow, listDeletedRows } from './softDelete.js';

const PAGE_SIZE = 1000;

// Asset Inventory is the baseline nearly every page matches screens against, and EIGHT different
// composite page loaders (Live Ops, Locations, Tickets, SIM Cards, Assets, Asset Inventory...) call
// this inside their own Promise.all, each under its own loadData cache key. Pointing the direct
// loadData('assetInventory') call sites at one shared key cannot help those: a different key means
// a different cache entry means another full fetch of the same 2,258 rows.
//
// Measured at app boot on 1 Sep 2026: three fetches of this exact query, 2.4s each, running
// SEQUENTIALLY - 306ms, then 2751ms, then 5147ms, each starting the instant the previous finished,
// because every completed fetch triggers a render that reaches the next page's key and starts its
// own. ~7.5 seconds of the load, before any rendering, on a fast office connection.
//
// Coalesced here, once, so every caller shares a single request instead of fixing eight call sites
// and hoping the ninth remembers: concurrent callers await the same in-flight promise, and a caller
// arriving within COALESCE_MS of a completed fetch reuses that result. Deliberately short, and
// deliberately NOT a cache - loadData still owns real caching and TTL revalidation. This only stops
// the identical query being issued several times in a row during one page load.
//
// resetAssetInventoryCache() is called alongside the existing invalidate('assetInventory') sites so
// an edit or a sync is never served a stale coalesced copy.
//
// Callers share one array instance rather than getting a copy - cloning 2,258 rows on every call
// would cost more than it saves, and every consumer here already treats it as read-only (sorting
// via [...rows].sort() and filtering into new arrays).
let inflightAssetInventory = null;
let lastAssetInventory = null;
let lastAssetInventoryAt = 0;
const COALESCE_MS = 15000;

export function resetAssetInventoryCache() {
  inflightAssetInventory = null;
  lastAssetInventory = null;
  lastAssetInventoryAt = 0;
}

export async function listAssetInventory() {
  if (inflightAssetInventory) return inflightAssetInventory;
  if (lastAssetInventory && Date.now() - lastAssetInventoryAt < COALESCE_MS) return lastAssetInventory;
  inflightAssetInventory = fetchAssetInventory()
    .then((rows) => { lastAssetInventory = rows; lastAssetInventoryAt = Date.now(); return rows; })
    .finally(() => { inflightAssetInventory = null; });
  return inflightAssetInventory;
}

async function fetchAssetInventory() {
  // Supabase's project-wide "Max Rows" setting hard-caps any single request (default 1000)
  // regardless of what .range() asks for, and this table (one row per physical screen) regularly
  // has 2,000+ - so page through it PAGE_SIZE rows at a time instead of one big request.
  // The pages are fetched in PARALLEL, not one after another. The original loop could not know how
  // many pages there were until a short one came back, so it awaited each before starting the next -
  // and with 2,251 live rows that is three round trips end to end. Measured at boot on 1 Sep 2026:
  // 267ms -> 2977ms -> 5393ms, each starting the instant the previous finished, ~7.5 seconds of a
  // page load spent waiting on a table totalling 529 kB.
  //
  // Asking for an exact count alongside the first page costs nothing extra (PostgREST returns it in
  // the Content-Range header of a request already being made) and turns the rest into one parallel
  // batch, so the whole table now costs about two round trips instead of N.
  const first = await supabase
    .from('asset_inventory')
    .select('*, asset_inventory_networks(network_id, networks(name))', { count: 'exact' })
    .is('deleted_at', null)
    .order('name')
    .range(0, PAGE_SIZE - 1);
  if (first.error) throw first.error;

  let all = first.data || [];
  // count can come back null if the header is unavailable; falling back to the old sequential walk
  // is better than silently truncating the table to its first page.
  const total = first.count;
  if (total == null) {
    for (let from = PAGE_SIZE; ; from += PAGE_SIZE) {
      const { data, error } = await supabase
        .from('asset_inventory')
        .select('*, asset_inventory_networks(network_id, networks(name))')
        .is('deleted_at', null)
        .order('name')
        .range(from, from + PAGE_SIZE - 1);
      if (error) throw error;
      all = all.concat(data);
      if (data.length < PAGE_SIZE) break;
    }
  } else if (total > PAGE_SIZE) {
    const starts = [];
    for (let from = PAGE_SIZE; from < total; from += PAGE_SIZE) starts.push(from);
    const pages = await Promise.all(starts.map((from) => supabase
      .from('asset_inventory')
      .select('*, asset_inventory_networks(network_id, networks(name))')
      .is('deleted_at', null)
      .order('name')
      .range(from, from + PAGE_SIZE - 1)));
    for (const p of pages) {
      if (p.error) throw p.error;
      all = all.concat(p.data || []);
    }
  }

  return all.map((row) => ({
    ...row,
    networkNames: (row.asset_inventory_networks || []).map((n) => n.networks?.name).filter(Boolean),
  }));
}

function toPayload(row) {
  return {
    // Omitted (not `?? null`) when the caller never set it, rather than defaulting to null - this
    // column is populated by CSV/API imports, never by the manual Add/Edit Screen form, and an
    // edit must never silently wipe out whatever an earlier import already set here.
    ...(row.sourceAssetId !== undefined ? { source_asset_id: row.sourceAssetId } : {}),
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

// networkIds: ids of already-existing `networks` rows (checkboxes in the Add/Edit Screen modal are
// keyed by network id, not name) - resolving names to ids happens separately via quickAddNetwork,
// same as the original's "Add Network" button inside that modal.
export async function saveAssetInventory(row, networkIds) {
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
  if (networkIds) {
    await supabase.from('asset_inventory_networks').delete().eq('asset_inventory_id', saved.id);
    const rows = networkIds.map((id) => ({ asset_inventory_id: saved.id, network_id: id }));
    if (rows.length) await supabase.from('asset_inventory_networks').insert(rows);
  }
  return saved;
}

export async function quickAddNetwork(name) {
  return ensureNetwork(name);
}

// Bulk Edit modal: patch is already snake_case DB columns, built by the caller from only the
// fields the admin actually touched - deliberately bypasses toPayload() (which would coerce
// pdooh_ready/managed_by_hm to false for every untouched row) so this only ever applies fields
// the admin explicitly set, across every selected row.
export async function bulkPatchAssetInventory(ids, patch) {
  const { error } = await supabase.from('asset_inventory').update(patch).in('id', ids);
  if (error) throw error;
}

export async function deleteAssetInventory(id) { return softDeleteRow('asset_inventory', id); }
export async function restoreAssetInventory(id) { return restoreRow('asset_inventory', id); }
export async function permanentlyDeleteAssetInventory(id) { return permanentlyDeleteRow('asset_inventory', id); }
export async function listDeletedAssetInventory() { return listDeletedRows('asset_inventory'); }
