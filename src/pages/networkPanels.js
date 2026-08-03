import { STATE, loadData, invalidate, openModal, toast, setState } from '../state.js';
import { loadingCard, registerModal } from '../modals.js';
import { getSetting } from '../data/settings.js';
import { listLocations } from '../data/locations.js';
import { listAssetInventory } from '../data/assetsInventory.js';
import { hiddenMemberIds, resolveMembers, sourceStats, heatmapColor } from '../data/locationStats.js';
import { listSyncLogs } from '../data/syncLogs.js';
import { supabase } from '../supabaseClient.js';
import { isAdmin, canAdd } from '../auth.js';
import { logAudit } from '../lib/audit.js';
import { esc } from '../lib/format.js';

// Top-of-page "last pulled" stat strip, shared by every network console page - shows when the
// last sync ran and what it found, with a View Sync Log button for reviewing mismatches over
// time (integration_sync_logs) instead of just the single most recent summary.
// Admin-only - "pulled from inventory / matched" is integration-internal detail, not something a
// team member needs (or should be able to use to infer inventory/API configuration details).
function syncStatBar(c, settingKey, integration) {
  const lastSync = c.lastSync ? new Date(c.lastSync).toLocaleString() : 'Never';
  return `
    <div class="kpi-row" style="margin-bottom:12px;">
      <div class="kpi"><div class="label">Last Synced</div><div class="value" style="font-size:15px;">${esc(lastSync)}</div></div>
      <div class="kpi"><div class="label">Pulled from Inventory</div><div class="value">${c.lastPulledCount ?? '-'}</div></div>
      <div class="kpi"><div class="label">Matched Live</div><div class="value">${c.lastMatchedCount ?? '-'}</div></div>
      <div class="kpi"><div class="label">Locations Updated</div><div class="value">${c.lastLocationsUpdated ?? '-'}</div></div>
    </div>
    <div style="margin:-4px 0 12px;">
      <button class="btn-sm" onclick="App.openSyncLogModal('${integration}')">View Sync Log</button>
    </div>
  `;
}

// Everyone (not just admins) gets a plain online/offline screen count - this is operational
// status, not integration/API detail. Sums sourceStats() across every location with data for this
// source; combined locations resolve their members internally so nothing double-counts.
function onlineOfflineSummary(dataLocs, allLocations, source, healthyField) {
  let offline = 0; let total = 0;
  for (const l of dataLocs) {
    const stats = sourceStats(l, allLocations, source, healthyField);
    offline += stats.offline; total += stats.total;
  }
  const online = total - offline;
  return `
    <div class="kpi-row" style="margin-bottom:12px;">
      <div class="kpi"><div class="label">Online</div><div class="value" style="color:#1f9d55;">${online}</div></div>
      <div class="kpi"><div class="label">Offline</div><div class="value" style="color:#c0392b;">${offline}</div></div>
      <div class="kpi"><div class="label">Total Tracked</div><div class="value">${total}</div></div>
    </div>
  `;
}

export function openSyncLogModal(integration) {
  openModal('syncLog', { integration });
}

registerModal('syncLog', (data) => {
  const integration = data.integration;
  const logs = loadData(`syncLog_${integration}`, () => listSyncLogs(integration));
  const label = integration === 'broadsign' ? 'Broadsign' : integration === 'grassfish' ? 'Grassfish' : integration;
  if (logs === null) return loadingCard();
  if (logs?.__error) return loadingCard(logs.__error);

  const rows = logs.map((l) => {
    const missing = l.missing_ids || [];
    return `
      <tr>
        <td class="small">${esc(new Date(l.synced_at).toLocaleString())}</td>
        <td class="tright">${l.pulled_count ?? '-'}</td>
        <td class="tright">${l.matched_count ?? '-'}</td>
        <td class="tright">${l.failed_count ?? '-'}</td>
        <td class="tright">${l.locations_updated ?? '-'}</td>
        <td>${l.error ? `<span style="color:#c0392b;">${esc(l.error)}</span>` : (missing.length ? `<details><summary class="small" style="cursor:pointer;">${missing.length} mismatch(es)</summary><div class="small muted" style="max-width:320px;white-space:normal;margin-top:4px;">${missing.map(esc).join(', ')}</div></details>` : '<span class="small muted">-</span>')}</td>
      </tr>
    `;
  }).join('') || `<tr><td colspan="6"><div class="empty">No sync history yet.</div></td></tr>`;

  return `
    <h3>${esc(label)} Sync Log</h3>
    <p class="small muted">Most recent ${logs.length} run(s). Each row's mismatch list shows Player Box IDs that were pulled from Asset Inventory but didn't get a response from the API (retired box, typo, or a domain/tenant mismatch) - use it to correct Asset Inventory data.</p>
    <div style="max-height:420px;overflow-y:auto;">
      <table>
        <thead><tr><th>Synced At</th><th class="tright">Pulled</th><th class="tright">Matched</th><th class="tright">Failed</th><th class="tright">Locations Updated</th><th>Mismatches / Error</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <div class="modal-actions"><button class="btn-sm" onclick="App.closeModal()">Close</button></div>
  `;
});

// JSON.stringify escapes backslashes/double-quotes per the JSON spec, but not single quotes -
// these payloads get embedded inside single-quoted onclick='...' attributes below, so any
// apostrophe in a venue/location/screen name would otherwise break out of the attribute.
function jsonAttr(obj) {
  return JSON.stringify(obj).replace(/'/g, '&#39;');
}

// Site Status Heatmap - one tile per location with data for this source, colored by
// offline share (locations/asset inventory are the source of truth; this just visualizes
// location_sub_assets + the health-count columns those tables already carry).
function renderNetworkPanel(source, healthyField, title, settingKey, syncFnName) {
  const cfg = loadData(settingKey, () => getSetting(settingKey));
  const allLocations = loadData('locationsForNetworkPanel', listLocations);
  if (cfg === null || allLocations === null) return loadingCard();
  if (cfg?.__error) return loadingCard(cfg.__error);
  if (allLocations?.__error) return loadingCard(allLocations.__error);

  const admin = isAdmin();
  const c = cfg || {};
  const hidden = hiddenMemberIds(allLocations);
  const hasDataDirect = (l) => (l.location_sub_assets || []).some((sa) => sa.source === source) || !!l[healthyField];
  // A combined/chain wrapper never carries location_sub_assets or a healthy-count of its own -
  // those live on its members - so its presence in the heatmap has to be decided by whether any
  // member has data, not by checking the wrapper row directly.
  const hasData = (l) => (l.is_combined ? resolveMembers(l, allLocations).some(hasDataDirect) : hasDataDirect(l));
  const dataLocs = allLocations.filter((l) => !hidden.has(l.id) && hasData(l));

  // Chains (Metro Red Line, Metro Bridges, Nakheel Pavilions, etc.) merge into one tile
  // aggregating every location that shares the chain tag, instead of flooding the grid with a
  // separate tile per individual station/bridge - matches how the Locations page treats chains.
  const chainNames = [...new Set(dataLocs.filter((l) => l.chain && !l.is_combined).map((l) => l.chain))];
  const chainedIds = new Set();
  const chainTiles = chainNames.map((chain) => {
    const members = allLocations.filter((l) => l.chain === chain && !l.is_combined);
    members.forEach((m) => chainedIds.add(m.id));
    let offline = 0; let total = 0;
    for (const m of members) {
      const stats = sourceStats(m, allLocations, source, healthyField);
      offline += stats.offline; total += stats.total;
    }
    const color = heatmapColor({ offline, total });
    const html = `<div style="background:${color};border-radius:10px;padding:12px;color:#fff;min-height:90px;display:flex;flex-direction:column;justify-content:space-between;cursor:pointer;" onclick='App.openOfflineAssetsModal(${jsonAttr({ chain, source, healthyField })})' title="Click to see offline assets">
      <div style="font-size:12.5px;font-weight:700;line-height:1.3;">${esc(chain)} <span style="font-weight:400;opacity:.85;">(${members.length} locations)</span></div>
      <div style="font-size:11px;opacity:.95;">${total ? `${offline} offline / ${total} total` : 'No data'}</div>
    </div>`;
    return { name: chain, html };
  });

  const individualTiles = dataLocs.filter((l) => !chainedIds.has(l.id)).map((l) => {
    const stats = sourceStats(l, allLocations, source, healthyField);
    const color = heatmapColor(stats);
    const html = `<div style="background:${color};border-radius:10px;padding:12px;color:#fff;min-height:90px;display:flex;flex-direction:column;justify-content:space-between;cursor:pointer;" onclick='App.openOfflineAssetsModal(${jsonAttr({ locId: l.id, source, healthyField })})' title="Click to see offline assets">
      <div style="font-size:12.5px;font-weight:700;line-height:1.3;">${esc(l.name)}${l.is_combined ? ' <span style="font-weight:400;opacity:.85;">(combined)</span>' : ''}</div>
      <div style="font-size:11px;opacity:.95;">${stats.total ? `${stats.offline} offline / ${stats.total} total` : 'No data'}</div>
    </div>`;
    return { name: l.name, html };
  });

  const search = (STATE.networkSearch || '').trim().toLowerCase();
  const allTiles = chainTiles.concat(individualTiles);
  const visibleTiles = search ? allTiles.filter((t) => t.name.toLowerCase().includes(search)) : allTiles;
  const tiles = visibleTiles.map((t) => t.html).join('');

  return `${onlineOfflineSummary(dataLocs, allLocations, source, healthyField)}
  ${admin ? syncStatBar(c, settingKey, source) : ''}
  <div class="banner" style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;">
    <span>${c.baseUrl ? `API configured${admin ? ` (${esc(c.baseUrl)})` : ''}.` : 'No live API configured yet.'} ${dataLocs.length ? `Showing the last imported snapshot for ${dataLocs.length} location(s), pulled from Locations.` : 'No data imported for this source yet.'}</span>
    <span style="display:flex;gap:8px;flex-wrap:wrap;">
      <button class="btn-sm" onclick="App.runNetworkSync('${settingKey}','${syncFnName}')" ${STATE.syncing === settingKey ? 'disabled' : ''}>${STATE.syncing === settingKey ? 'Syncing...' : 'Sync Now'}</button>
      ${admin ? `<button class="btn-sm" onclick="App.setPage('settings')">Configure API</button>` : ''}
    </span>
  </div>
  ${allTiles.length ? `<div class="card">
    <div class="card-head" style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;">
      <div><h3>Site Status Heatmap</h3><div class="desc">Colored by number/share of offline units - green = all online, red = high offline share. Locations that belong to the same chain are merged into one tile. Click a tile to see what's offline and raise a ticket.</div></div>
      <input id="net-search" placeholder="Search by location or chain name..." value="${esc(STATE.networkSearch || '')}" oninput="App.setNetworkSearch(this.value)" style="min-width:220px;padding:7px 10px;border:1px solid var(--border);border-radius:8px;">
    </div>
    ${visibleTiles.length ? `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:10px;">${tiles}</div>` : `<div class="empty">No location or chain matches "${esc(STATE.networkSearch || '')}".</div>`}
  </div>` : `<div class="card"><div class="empty">No ${esc(title)} data yet.${admin ? ' Configure the API above, or run a sync, to populate this view.' : ' Ask an Admin to configure this.'}</div></div>`}`;
}

export function setNetworkSearch(value) { setState({ networkSearch: value }); }

export function renderBroadsignPanel() {
  return renderNetworkPanel('broadsign', 'broadsign_healthy_count', 'Broadsign Console', 'broadsignApi', 'broadsign-sync');
}

// Until grassfish-sync has run at least once with Status Field Name/Offline Status Values
// calibrated (see Settings > Integrations), no location has a location_sub_assets row sourced
// from Grassfish yet - fall back to an Asset Inventory view grouped by venue (Player Type =
// Grassfish) so the console stays useful rather than permanently empty. Once calibrated, this
// switches to the same heatmap Broadsign uses.
export function renderGrassfishPanel() {
  const allLocations = loadData('locationsForNetworkPanel', listLocations);
  if (allLocations === null) return loadingCard();
  if (allLocations?.__error) return loadingCard(allLocations.__error);
  const hasLiveData = allLocations.some((l) => (l.location_sub_assets || []).some((sa) => sa.source === 'grassfish'));
  if (hasLiveData) {
    return renderNetworkPanel('grassfish', 'grassfish_healthy_count', 'Grassfish Console', 'grassfishApi', 'grassfish-sync');
  }

  const cfg = loadData('grassfishApi', () => getSetting('grassfishApi'));
  const inventory = loadData('assetInventoryForGrassfishPanel', listAssetInventory);
  if (cfg === null || inventory === null) return loadingCard();
  if (cfg?.__error) return loadingCard(cfg.__error);
  if (inventory?.__error) return loadingCard(inventory.__error);

  const admin = isAdmin();
  const c = cfg || {};
  const screens = inventory.filter((r) => r.player_type === 'Grassfish');
  const byVenue = {};
  screens.forEach((r) => {
    const v = r.venue || 'Unassigned';
    if (!byVenue[v]) byVenue[v] = [];
    byVenue[v].push(r);
  });
  const venues = Object.keys(byVenue).sort((a, b) => a.localeCompare(b));
  const search = (STATE.networkSearch || '').trim().toLowerCase();
  const visibleVenues = search ? venues.filter((v) => v.toLowerCase().includes(search)) : venues;
  const tiles = visibleVenues.map((v) => {
    const list = byVenue[v];
    return `<div style="background:#2f6fb3;border-radius:10px;padding:12px;color:#fff;min-height:90px;display:flex;flex-direction:column;justify-content:space-between;cursor:pointer;" onclick='App.openGrassfishVenueModal(${jsonAttr(v)})' title="Click to see screens at this venue">
      <div style="font-size:12.5px;font-weight:700;line-height:1.3;">${esc(v)}</div>
      <div style="font-size:11px;opacity:.95;">${list.length} screen${list.length === 1 ? '' : 's'}</div>
    </div>`;
  }).join('');

  return `${admin ? syncStatBar(c, 'grassfishApi', 'grassfish') : ''}
  <div class="banner" style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;">
    <span>${c.baseUrl ? `API configured${admin ? ` (${esc(c.baseUrl)})` : ''}.` : 'No live API configured yet.'} ${screens.length} Grassfish screen${screens.length === 1 ? '' : 's'} across ${venues.length} venue${venues.length === 1 ? '' : 's'} in Asset Inventory. This view reflects Asset Inventory directly (Player Type = Grassfish) rather than a live online/offline feed - once a sync succeeds at least once, this page switches to the same online/offline heatmap the Broadsign Console uses.</span>
    <span style="display:flex;gap:8px;flex-wrap:wrap;">
      <button class="btn-sm" onclick="App.runNetworkSync('grassfishApi','grassfish-sync')" ${STATE.syncing === 'grassfishApi' ? 'disabled' : ''}>${STATE.syncing === 'grassfishApi' ? 'Syncing...' : 'Sync Now'}</button>
      ${admin ? `<button class="btn-sm" onclick="App.setPage('settings')">Configure API</button>` : ''}
    </span>
  </div>
  ${venues.length ? `<div class="card">
    <div class="card-head" style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;">
      <div><h3>Screens by Venue</h3><div class="desc">One tile per venue with at least one Grassfish screen in Asset Inventory. Click a tile to see the individual screens and raise a ticket if needed.</div></div>
      <input id="net-search" placeholder="Search by venue name..." value="${esc(STATE.networkSearch || '')}" oninput="App.setNetworkSearch(this.value)" style="min-width:220px;padding:7px 10px;border:1px solid var(--border);border-radius:8px;">
    </div>
    ${visibleVenues.length ? `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:10px;">${tiles}</div>` : `<div class="empty">No venue matches "${esc(STATE.networkSearch || '')}".</div>`}
  </div>` : `<div class="card"><div class="empty">No screens tagged Player Type = Grassfish in Asset Inventory yet. Set a screen's Player Type to "Grassfish" under Asset Inventory to have it show up here.</div></div>`}`;
}

// Fleet-wide "Devices by ..." donut cards, computed server-side by iot-sync from the live device
// list (app_settings.iotApi.deviceBreakdown) - independent of the per-location heatmap below, so
// this shows as soon as a sync has run once, whether or not Offline Status Values is calibrated
// yet. Plain inline SVG rather than a charting dependency - four categories, static per sync.
const DONUT_PALETTE = ['#00c2c2', '#2f6fb3', '#1f9d55', '#e67e22', '#8e44ad', '#c0392b', '#7f8c8d', '#f1c40f', '#16a085', '#d35400'];

function donutItems(counts) {
  return Object.entries(counts || {}).sort((a, b) => b[1] - a[1]).map(([label, value]) => ({ label, value }));
}

function renderDonutSvg(items) {
  const total = items.reduce((s, it) => s + it.value, 0) || 1;
  const r = 62; const cx = 80; const cy = 80; const strokeWidth = 30;
  const circumference = 2 * Math.PI * r;
  let offset = 0;
  const segs = items.map((it, idx) => {
    const dash = (it.value / total) * circumference;
    const circle = `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${DONUT_PALETTE[idx % DONUT_PALETTE.length]}" stroke-width="${strokeWidth}" stroke-dasharray="${dash} ${circumference - dash}" stroke-dashoffset="${-offset}" transform="rotate(-90 ${cx} ${cy})"><title>${esc(it.label)}: ${it.value}</title></circle>`;
    offset += dash;
    return circle;
  }).join('');
  return `<svg viewBox="0 0 160 160" width="160" height="160" style="display:block;margin:0 auto;">${segs}</svg>`;
}

function renderDonutCard(title, items) {
  const total = items.reduce((s, it) => s + it.value, 0);
  const legend = items.map((it, idx) => `<span style="display:inline-flex;align-items:center;gap:5px;font-size:11.5px;margin:2px 8px 2px 0;"><span style="width:10px;height:10px;border-radius:2px;background:${DONUT_PALETTE[idx % DONUT_PALETTE.length]};display:inline-block;flex:none;"></span>${esc(it.label)} (${it.value})</span>`).join('');
  return `<div class="card" style="text-align:center;">
    <div class="card-head" style="text-align:left;"><h3>${esc(title)}</h3></div>
    <div style="display:flex;flex-wrap:wrap;justify-content:center;margin-bottom:10px;">${legend || '<span class="small muted">No data</span>'}</div>
    ${total ? renderDonutSvg(items) : ''}
  </div>`;
}

// Fixed display order matching the states the aioo console itself uses (confirmed from the
// user's own reference screenshot) - always shown even at zero count, per "include all status
// values", rather than only whatever states happened to appear in the latest pull.
const IOT_STATE_ORDER = ['Idle', 'Ready', 'Tracking', 'Offline', 'Unknown'];

function canonicalStateItems(byState) {
  const b = byState || {};
  const items = IOT_STATE_ORDER.map((label) => ({ label, value: b[label] || 0 }));
  for (const [label, value] of Object.entries(b)) {
    if (!IOT_STATE_ORDER.includes(label)) items.push({ label, value });
  }
  return items;
}

// Standalone dashboard of whatever iot-sync last pulled live from the aioo IoT Admin Console -
// deliberately NOT matched against Asset Inventory/Locations (that matching lives in iot-sync for
// a future per-site heatmap, but this page just shows the fleet as the vendor's own API reports
// it, same as the "Devices by ..." dashboard in aioo's own console).
export function renderIotPanel() {
  const cfg = loadData('iotApi', () => getSetting('iotApi'));
  if (cfg === null) return loadingCard();
  if (cfg?.__error) return loadingCard(cfg.__error);

  const admin = isAdmin();
  const c = cfg || {};
  const b = c.deviceBreakdown;

  const statusBar = admin ? `<div class="banner" style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;">
    <span>${c.baseUrl ? `API configured (${esc(c.baseUrl)})${c.lastSync ? `, last synced ${esc(new Date(c.lastSync).toLocaleString())}` : ', not tested yet'}.` : 'No live API configured yet.'}${c.lastError ? ` <span style="color:#c0392b;">${esc(c.lastError)}</span>` : ''}</span>
    <span style="display:flex;gap:8px;flex-wrap:wrap;">
      <button class="btn-sm" onclick="App.runNetworkSync('iotApi','iot-sync')" ${STATE.syncing === 'iotApi' ? 'disabled' : ''}>${STATE.syncing === 'iotApi' ? 'Syncing...' : 'Sync Now'}</button>
      <button class="btn-sm" onclick="App.setPage('settings')">Configure API</button>
    </span>
  </div>` : '';

  if (!b || !b.totalDevices) {
    return `${statusBar}<div class="card"><div class="empty">No live device data yet.${admin ? ' Configure the API in Settings, then Sync Now.' : ' Ask an Admin to configure this.'}</div></div>`;
  }

  return `${statusBar}
  <div class="small muted" style="margin:10px 0 8px;">${b.totalDevices} device${b.totalDevices === 1 ? '' : 's'} in the fleet as of ${c.lastSync ? new Date(c.lastSync).toLocaleString() : 'last sync'}.</div>
  <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:14px;">
    ${renderDonutCard('Devices by Platform', donutItems(b.byPlatform))}
    ${renderDonutCard('Devices by State', canonicalStateItems(b.byState))}
    ${renderDonutCard('Devices by Camera Type', donutItems(b.byCameraType))}
    ${renderDonutCard('Devices by Version', donutItems(b.byVersion))}
  </div>`;
}

export function openOfflineAssetsModal(opts) {
  openModal('offlineAssetsModal', opts);
}

export function openGrassfishVenueModal(venue) {
  openModal('grassfishVenueModal', { venue });
}

export async function runNetworkSync(settingKey, functionName) {
  setState({ syncing: settingKey });
  try {
    const { data, error } = await supabase.functions.invoke(functionName, { body: {} });
    if (error) throw error;
    if (data?.error) throw new Error(data.error);
    await logAudit(`${functionName} sync`, data?.summary || '');
    invalidate(settingKey);
    invalidate('locationsForNetworkPanel');
    invalidate('assetInventoryForGrassfishPanel');
    toast(data?.summary || 'Sync complete');
  } catch (e) {
    toast(e.message || 'Sync failed', 'error');
  } finally {
    setState({ syncing: null });
  }
}

registerModal('offlineAssetsModal', (data) => {
  const allLocations = STATE.pageData.locationsForNetworkPanel?.data || [];
  const ticketAddOk = canAdd('tickets');
  const sourceLabel = data.source === 'broadsign' ? 'Broadsign Console' : data.source === 'grassfish' ? 'Grassfish Console' : '';

  let items = [];
  let displayName;
  let singleLocation = null;
  if (data.chain) {
    const members = allLocations.filter((m) => m.chain === data.chain && !m.is_combined);
    for (const m of members) {
      const stats = sourceStats(m, allLocations, data.source, data.healthyField);
      items.push(...(stats.offlineItems || []));
    }
    displayName = `${data.chain} (${members.length} locations)`;
  } else {
    singleLocation = allLocations.find((x) => x.id === data.locId);
    const stats = singleLocation ? sourceStats(singleLocation, allLocations, data.source, data.healthyField) : { offlineItems: [] };
    items = stats.offlineItems || [];
    displayName = singleLocation ? singleLocation.name : '';
  }

  const rows = items.map((i) => {
    const prefill = {
      title: `${i.location} - ${i.name} Offline`,
      location: i.location || '',
      description: `${i.detail || 'Offline'}${sourceLabel ? ` (via ${sourceLabel})` : ''}`,
      type: 'Issue',
    };
    return `<tr><td>${esc(i.location)}</td><td>${esc(i.name)}</td><td>${esc(i.detail || '')}</td><td>${ticketAddOk ? `<button class="btn-sm" onclick='App.openTicketFromOffline(${jsonAttr(prefill)})'>+ Ticket</button>` : ''}</td></tr>`;
  }).join('') || `<tr><td colspan="4"><div class="empty">Nothing offline here.</div></td></tr>`;

  // Bulk "ticket for all" only makes sense against a single real location - a chain tile spans
  // many locations, so there's no one place to prefill.
  const bulkPrefill = singleLocation ? {
    title: `${singleLocation.name} - ${items.length} item${items.length === 1 ? '' : 's'} offline${sourceLabel ? ` (${sourceLabel})` : ''}`,
    location: singleLocation.name,
    description: items.map((i) => `${i.name}: ${i.detail || 'Offline'}`).join('\n'),
    type: 'Issue',
  } : null;

  return `
    <h3>Offline - ${esc(displayName)}</h3>
    <table>
      <thead><tr><th>Location</th><th>Name</th><th>Detail</th><th></th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <div class="modal-actions">
      ${(ticketAddOk && bulkPrefill && items.length > 1) ? `<button class="btn-sm" onclick='App.openTicketFromOffline(${jsonAttr(bulkPrefill)})'>Create Ticket for All</button>` : ''}
      <button class="btn-sm" onclick="App.closeModal()">Close</button>
    </div>
  `;
});

registerModal('grassfishVenueModal', (data) => {
  const venue = data.venue || '';
  const inventory = STATE.pageData.assetInventoryForGrassfishPanel?.data || [];
  const screens = inventory.filter((r) => r.player_type === 'Grassfish' && (r.venue || '') === venue);
  const ticketAddOk = canAdd('tickets');
  const admin = isAdmin();
  const rows = screens.map((r) => {
    const prefill = {
      title: `${venue} - ${r.name} Issue`,
      location: venue,
      description: `Screen: ${r.name}${r.format ? ` (${r.format})` : ''}${r.player_box_id ? ` - Player Box ID: ${r.player_box_id}` : ''}`,
      type: 'Issue',
    };
    return `<tr>
      <td><b>${esc(r.name)}</b></td>
      <td>${esc(r.format || '-')}${r.width && r.height ? `<div class="small muted">${r.width}x${r.height}</div>` : ''}</td>
      ${admin ? `<td>${esc(r.player_box_id || '-')}</td>` : ''}
      <td>${ticketAddOk ? `<button class="btn-sm" onclick='App.openTicketFromOffline(${jsonAttr(prefill)})'>+ Ticket</button>` : ''}</td>
    </tr>`;
  }).join('') || `<tr><td colspan="${admin ? 4 : 3}"><div class="empty">No Grassfish screens at this venue.</div></td></tr>`;
  return `
    <h3>Grassfish - ${esc(venue)}</h3>
    <div class="small muted" style="margin-bottom:8px;">${screens.length} screen${screens.length === 1 ? '' : 's'} at this venue, pulled from Asset Inventory (Player Type = Grassfish).</div>
    <table>
      <thead><tr><th>Name</th><th>Format</th>${admin ? '<th>Player Box ID</th>' : ''}<th></th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <div class="modal-actions"><button class="btn-sm" onclick="App.closeModal()">Close</button></div>
  `;
});

export function openTicketFromOffline(prefill) {
  openModal('ticket', { ...prefill, date_reported: new Date().toISOString().slice(0, 10), status: 'Open' });
}
