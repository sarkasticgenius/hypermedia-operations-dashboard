// One-time bulk loader for this company's real operational data - the large arrays that used to
// be hardcoded straight into hypermedia-operations.html (ASSET_INVENTORY_ROWS, SIM_IMPORT_ROWS,
// BROADSIGN_LOCATIONS, and the real dashboard-links list) get loaded into Supabase from here.
//
// scripts/seed-data/*.json is NOT committed to this repo (see .gitignore) - it contains real
// operational data (SIM ICCIDs, remote-access IDs, internal monitoring URLs, exact device
// inventory) that shouldn't sit in a git history, private repo or not. The live Supabase project
// already has this data loaded (done once, locally, the same way). To regenerate that folder
// yourself: run `node scripts/extract-legacy-data.mjs` pointed at your own source file (see that
// script's header), or hand-build JSON files matching the shapes read below.
//
// Deliberately NOT seeded: the small demo/placeholder records the original file also shipped
// (fake assets, orders, tickets, permits, contractors with @example.com emails, etc.) - those
// were sample data for a fresh install, not real operations, so seeding them into a production
// Supabase project would just be clutter. Add real records for those through the app itself
// (Admin/Settings pages) instead.
//
// Usage: fill SUPABASE_SERVICE_ROLE_KEY in .env, then `npm run seed`. Safe to re-run - every
// insert is an upsert keyed on a natural identifier (source_asset_id, sim_number, location name).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import 'dotenv/config';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, 'seed-data');

const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceRoleKey) {
  console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env - see .env.example.');
  process.exit(1);
}
const supabase = createClient(url, serviceRoleKey);

function readJson(name) {
  return JSON.parse(fs.readFileSync(path.join(DATA_DIR, name), 'utf-8'));
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function seedAssetInventory() {
  const rows = readJson('asset-inventory-rows.json');
  const payload = rows.map((r) => ({
    source_asset_id: r[0], name: r[1], venue: r[2], location: r[3], category: r[4],
    pdooh_ready: !!r[5], format: r[6] || null, width: r[7] || null, height: r[8] || null,
    screens: r[9] || null, faces: r[10] || null, special_render: r[11] || null,
    anydesk_id: r[12] || null, teamviewer_id: r[13] || null, sensor_id: r[14] || null,
    lat: r[15] || null, lng: r[16] || null, multiplier: r[17] || null, position: r[18] || null,
    player_box_id: r[19] || null, ad_duration: r[20] || null, player_type: r[21] || null,
    managed_by_hm: !!r[22], source_created_at: r[23] || null, source: 'export',
  }));
  const networksByRow = rows.map((r) => String(r[24] || '').split(',').map((s) => s.trim()).filter(Boolean));

  let count = 0;
  for (const batch of chunk(payload, 500)) {
    const { error } = await supabase.from('asset_inventory').upsert(batch, { onConflict: 'source_asset_id' });
    if (error) throw error;
    count += batch.length;
    console.log(`  asset_inventory: ${count}/${payload.length}`);
  }

  // Networks + join table
  const allNetworkNames = [...new Set(networksByRow.flat())];
  if (allNetworkNames.length) {
    const { error } = await supabase.from('networks').upsert(
      allNetworkNames.map((name) => ({ name })), { onConflict: 'name' },
    );
    if (error) throw error;
  }
  const { data: networkRows } = await supabase.from('networks').select('id, name');
  const networkIdByName = new Map((networkRows || []).map((n) => [n.name.toLowerCase(), n.id]));

  const { data: invRows } = await supabase.from('asset_inventory').select('id, source_asset_id');
  const invIdBySourceId = new Map((invRows || []).map((r) => [r.source_asset_id, r.id]));

  const joinRows = [];
  rows.forEach((r, idx) => {
    const invId = invIdBySourceId.get(r[0]);
    if (!invId) return;
    for (const name of networksByRow[idx]) {
      const netId = networkIdByName.get(name.toLowerCase());
      if (netId) joinRows.push({ asset_inventory_id: invId, network_id: netId });
    }
  });
  for (const batch of chunk(joinRows, 1000)) {
    const { error } = await supabase.from('asset_inventory_networks').upsert(batch, { onConflict: 'asset_inventory_id,network_id' });
    if (error) throw error;
  }
  console.log(`  asset_inventory_networks: ${joinRows.length} links, ${allNetworkNames.length} distinct networks`);
}

async function seedSimCards() {
  const rows = readJson('sim-import-rows.json');
  const payload = rows.map((r) => ({
    sim_number: r[0] || null, iccid: r[1] || null, carrier: r[2] || null, data_plan: r[3] || null,
    billing_cost: r[4] || null, status: r[5] || 'In Stock', deployed_location_name: r[6] || null,
    deployed_asset_inv_label: r[7] || null, notes: r[8] || null, source_sheet: r[9] || null,
    has_mismatch: !!r[10], mismatch_note: r[11] || null,
  })).filter((r) => r.sim_number);

  let count = 0;
  for (const batch of chunk(payload, 500)) {
    const { error } = await supabase.from('sim_cards').upsert(batch, { onConflict: 'sim_number' });
    if (error) throw error;
    count += batch.length;
    console.log(`  sim_cards: ${count}/${payload.length}`);
  }

  // Best-effort link deployed_location_name/deployed_asset_inv_label back to real FKs now that
  // locations + asset_inventory are seeded.
  const { data: locs } = await supabase.from('locations').select('id, name');
  const locIdByName = new Map((locs || []).map((l) => [l.name.toLowerCase(), l.id]));
  const { data: sims } = await supabase.from('sim_cards').select('id, deployed_location_name').not('deployed_location_name', 'is', null);
  for (const s of sims || []) {
    const locId = locIdByName.get(String(s.deployed_location_name).toLowerCase());
    if (locId) await supabase.from('sim_cards').update({ deployed_location_id: locId }).eq('id', s.id);
  }
}

async function seedLocationsFromBroadsign() {
  const rows = readJson('broadsign-locations.json');
  const nowIso = new Date().toISOString();
  const payload = rows.map(([name, chain, healthyCount]) => ({
    name, type: 'Installed', chain: chain || null,
    broadsign_healthy_count: healthyCount, broadsign_as_of: nowIso,
  }));

  for (const batch of chunk(payload, 200)) {
    for (const row of batch) {
      const { data: existing } = await supabase.from('locations').select('id').ilike('name', row.name).maybeSingle();
      if (existing) {
        await supabase.from('locations').update(row).eq('id', existing.id);
      } else {
        await supabase.from('locations').insert(row);
      }
    }
  }
  console.log(`  locations: upserted ${payload.length} from Broadsign snapshot`);

  const { data: locs } = await supabase.from('locations').select('id, name');
  const locIdByName = new Map((locs || []).map((l) => [l.name.toLowerCase(), l.id]));
  const subAssetRows = [];
  for (const [name, , , exceptions] of rows) {
    const locId = locIdByName.get(String(name).toLowerCase());
    if (!locId || !exceptions?.length) continue;
    for (const [pid, pname, status] of exceptions) {
      subAssetRows.push({
        location_id: locId, name: pname, status: 'Offline', source: 'broadsign',
        notes: `Broadsign ID: ${pid} - Status: ${status}`,
      });
    }
  }
  if (subAssetRows.length) {
    const { error } = await supabase.from('location_sub_assets').insert(subAssetRows);
    if (error) throw error;
  }
  console.log(`  location_sub_assets: ${subAssetRows.length} offline/exception players`);
}

async function seedDashboardLinks() {
  const sections = readJson('dashboard-sections.json');
  for (const section of sections) {
    const { data: existing } = await supabase.from('dashboard_sections').select('id').eq('lock_key', section.lockKey).maybeSingle();
    if (!existing) continue; // reference-seed migration already creates the 3 locked sections
    const { data: existingLinks } = await supabase.from('dashboards').select('name').eq('section_id', existing.id);
    const existingNames = new Set((existingLinks || []).map((d) => d.name));
    const toInsert = (section.dashboards || [])
      .filter((d) => !existingNames.has(d.name))
      .map((d) => ({ section_id: existing.id, name: d.name, url: d.url }));
    if (toInsert.length) {
      const { error } = await supabase.from('dashboards').insert(toInsert);
      if (error) throw error;
    }
    console.log(`  dashboards: ${toInsert.length} link(s) added to "${section.name}"`);
  }
}

async function main() {
  console.log('Seeding asset_inventory + networks...');
  await seedAssetInventory();
  console.log('Seeding locations from Broadsign snapshot...');
  await seedLocationsFromBroadsign();
  console.log('Seeding sim_cards...');
  await seedSimCards();
  console.log('Seeding real dashboard links...');
  await seedDashboardLinks();
  console.log('Done.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
