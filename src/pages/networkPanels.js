import { STATE, loadData, invalidate, openModal, closeModal, toast, setState } from '../state.js';
import { loadingCard, registerModal } from '../modals.js';
import { getSetting, saveSetting } from '../data/settings.js';
import { listLocations } from '../data/locations.js';
import { listAssetInventory } from '../data/assetsInventory.js';
import { listWorkspaceDevices } from '../data/workspaceDevices.js';
import { hiddenMemberIds, resolveMembers, sourceStats, heatmapColor } from '../data/locationStats.js';
import { svgGroupedBarChart } from '../lib/charts.js';
import { listSyncLogs } from '../data/syncLogs.js';
import { supabase } from '../supabaseClient.js';
import { isAdmin, canAdd } from '../auth.js';
import { logAudit } from '../lib/audit.js';
import { esc, fmtRelativeTime } from '../lib/format.js';
import { remoteAccessUrl } from '../lib/remoteAccess.js';
import { aiooSiteCategory, aiooSiteDisplayName, SITE_CATEGORIES } from '../lib/aiooSiteCategory.js';
import { sortTh, applySort, colWidthCh, FIXED_TABLE_STYLE } from '../lib/sortableTable.js';

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

  const sortedLogs = applySort(logs, `syncLog_${integration}`, {
    syncedAt: (l) => l.synced_at || '',
    pulled: (l) => l.pulled_count ?? -1,
    matched: (l) => l.matched_count ?? -1,
    failed: (l) => l.failed_count ?? -1,
    locationsUpdated: (l) => l.locations_updated ?? -1,
  });
  const rows = sortedLogs.map((l) => {
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
    <div style="max-height:420px;overflow-y:auto;overflow-x:auto;">
      <table style="${FIXED_TABLE_STYLE}">
        <thead><tr>${sortTh(`syncLog_${integration}`, 'syncedAt', 'Synced At', 18)}${sortTh(`syncLog_${integration}`, 'pulled', 'Pulled', 8)}${sortTh(`syncLog_${integration}`, 'matched', 'Matched', 8)}${sortTh(`syncLog_${integration}`, 'failed', 'Failed', 8)}${sortTh(`syncLog_${integration}`, 'locationsUpdated', 'Locations Updated', 12)}<th>Mismatches / Error</th></tr></thead>
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

// Fleet-wide "Devices by ..." chart cards, computed server-side by iot-sync from the live device
// list (app_settings.iotApi.deviceBreakdown) - independent of the per-location heatmap below, so
// this shows as soon as a sync has run once, whether or not Offline Status Values is calibrated
// yet. Plain inline SVG rather than a charting dependency.
const CHART_PALETTE = ['#00c2c2', '#2f6fb3', '#1f9d55', '#e67e22', '#8e44ad', '#c0392b', '#7f8c8d', '#f1c40f', '#16a085', '#d35400'];

function donutItems(counts) {
  return Object.entries(counts || {}).sort((a, b) => b[1] - a[1]).map(([label, value]) => ({ label, value }));
}

// Bar-only now (the pie/bar toggle and pie renderer were removed) - each of the 4 cards below gets
// its own accent color (cycled from CHART_PALETTE by card index) rather than a bespoke per-wedge
// palette, and renders inside a .bento-tile to match Live Ops' tile styling instead of a plain
// .card.
// colorForLabel (optional) overrides the color per bar instead of the whole series sharing one
// accent color - needed for Devices by Connectivity, where each bar IS a semantic state (Online/
// Offline) that should read as green/red at a glance rather than two identically-colored bars.
function renderIotChartCard(title, items, colorIndex, colorForLabel) {
  const total = items.reduce((s, it) => s + it.value, 0);
  const color = CHART_PALETTE[colorIndex % CHART_PALETTE.length];
  const series = { name: title, color, values: items.map((it) => it.value) };
  if (colorForLabel) series.colors = items.map((it) => colorForLabel(it.label) || color);
  return `<div class="bento-tile bento-span-2">
    <div class="card-head"><h3>${esc(title)}</h3></div>
    ${total ? svgGroupedBarChart(items.map((it) => it.label), [series], { width: 460, height: 190 }) : '<div class="empty">No data</div>'}
  </div>`;
}

// Green/red so Online/Offline read at a glance without checking numbers - matches heatmapColor's
// own "all online"/"worst" endpoints (src/data/locationStats.js) for visual consistency with the
// category heatmap tiles above.
function connectivityColor(label) {
  if (label === 'Online') return '#1f9d55';
  if (label === 'Offline') return '#c0392b';
  return null;
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

// Mirrors iot-sync's countBy() aggregation exactly, run client-side so toggling one device's
// excluded flag updates the charts instantly without waiting on (or triggering) a live re-pull
// from the vendor API.
function recomputeIotBreakdown(devices) {
  const countBy = (getLabel) => {
    const counts = {};
    for (const d of devices) {
      const label = getLabel(d) || 'Unknown';
      counts[label] = (counts[label] || 0) + 1;
    }
    return counts;
  };
  return {
    totalDevices: devices.length,
    byPlatform: countBy((d) => d.platform),
    byState: countBy((d) => d.state),
    byCameraType: countBy((d) => d.cameraType),
    byVersion: countBy((d) => d.version),
    byConnectivity: countBy((d) => (d.online ? 'Online' : 'Offline')),
  };
}

// Persisted on app_settings.iotApi.excludedDeviceIds - iot-sync reads this same field on every
// future pull and filters BEFORE computing its own deviceBreakdown, so a removed device stays
// removed across re-syncs rather than reappearing the moment the vendor API returns it again.
export async function toggleIotDeviceExcluded(deviceId, excluded) {
  const cfg = STATE.pageData.iotApi?.data || {};
  const excludedSet = new Set(cfg.excludedDeviceIds || []);
  if (excluded) excludedSet.add(deviceId); else excludedSet.delete(deviceId);
  const excludedDeviceIds = [...excludedSet];
  const activeDevices = (cfg.lastDevices || []).filter((d) => !excludedSet.has(d.deviceId));
  const deviceBreakdown = recomputeIotBreakdown(activeDevices);
  try {
    await saveSetting('iotApi', { ...cfg, excludedDeviceIds, deviceBreakdown });
    await logAudit(excluded ? 'Exclude IoT device' : 'Re-include IoT device', deviceId);
    invalidate('iotApi');
    toast(excluded ? 'Device excluded - dropped from the charts and future syncs.' : 'Device re-included.');
  } catch (e) {
    toast(e.message || 'Failed to update device', 'error');
  }
}

export function setIotDeviceSearch(value) { setState({ iotDeviceSearch: value, iotDevicePage: 0 }); }
export function setIotDevicePage(page) { setState({ iotDevicePage: page }); }
export function setIotDeviceFilter(value) { setState({ iotDeviceFilter: value, iotDevicePage: 0 }); }

// Full checkable device list, sourced from iotApi.lastDevices (every device the last sync saw,
// excluded or not) - lets an admin find and exclude devices removed on their side, or find and
// re-include one, without needing a live vendor pull just to browse the fleet.
function renderIotDeviceTable(cfg) {
  const devices = cfg.lastDevices || [];
  if (!devices.length) return '';
  const admin = isAdmin();
  const excludedSet = new Set(cfg.excludedDeviceIds || []);
  const search = (STATE.iotDeviceSearch || '').trim().toLowerCase();
  // Defaults to hiding excluded devices - the charts above already exclude them from every count,
  // so the device list should too unless an admin deliberately asks to review them (via "All
  // devices" or "Excluded only", both still available below - excluded devices aren't hidden
  // entirely, just not mixed into the default view).
  const filterMode = STATE.iotDeviceFilter || 'active';
  const filtered = devices.filter((d) => {
    if (filterMode === 'active' && excludedSet.has(d.deviceId)) return false;
    if (filterMode === 'excluded' && !excludedSet.has(d.deviceId)) return false;
    if (!search) return true;
    const hay = `${d.deviceId} ${d.displayName} ${d.macAddress} ${d.venue} ${d.storeName} ${d.asset} ${d.entrance} ${d.platform} ${d.state}`.toLowerCase();
    return hay.includes(search);
  });
  // Sorted on the already-filtered set (search + Active/All/Excluded) so sort order and filters
  // compose the way a user expects, then paginated on top of that - matches the Asset Inventory
  // list's own filter-then-sort-then-paginate order (assets.js).
  const sorted = applySort(filtered, 'iotDevices', {
    deviceId: (d) => d.deviceId || '',
    name: (d) => d.displayName || d.macAddress || '',
    mac: (d) => d.macAddress || '',
    venue: (d) => d.venue || '',
    platform: (d) => d.platform || '',
    state: (d) => d.state || '',
    connectivity: (d) => (d.online ? 1 : 0),
    lastSeen: (d) => d.lastSeenUtc || '',
  });
  const pageSize = 50;
  const totalPages = Math.max(1, Math.ceil(sorted.length / pageSize));
  const page = Math.min(STATE.iotDevicePage || 0, totalPages - 1);
  const pageRows = sorted.slice(page * pageSize, page * pageSize + pageSize);

  // Sized from the LONGEST INDIVIDUAL LINE the venue cell stacks (venue/store/asset/entrance),
  // not the concatenated length of all four - those render one above another via <br>, not side
  // by side, so summing them would wildly overestimate the width an actual line ever needs. Left
  // unsized before, this column fell back to the browser's own auto-width under table-layout:fixed
  // - centred, the leftover space split evenly on both sides and went unnoticed; left-aligned (see
  // the .tleft change above) that same leftover space became one glaring gap on the right instead,
  // confirmed live. Computed from the FULL filtered set, not just this page, so paging/sorting
  // doesn't shift the column width under the user (same reasoning as colWidthCh itself).
  const venueColWidth = colWidthCh(
    filtered,
    (d) => [d.venue, d.storeName, d.asset, d.entrance].filter(Boolean).reduce((longest, s) => (s.length > longest.length ? s : longest), ''),
    'Venue',
    { min: 14, max: 34 },
  );

  // Venue cell shows the full location chain the vendor API gives per device - venue (mall/site),
  // then store/aisle and the specific asset/entrance name within it, each on their own line -
  // matching the vendor's own IoT Admin Console venue display instead of splitting store into a
  // separate column, since "which physical screen/camera is this" is what actually distinguishes
  // otherwise-identical rows at the same venue (e.g. IOT_5 vs IOT_6).
  function venueCellHtml(d) {
    const lines = [esc(d.venue || '-')];
    if (d.storeName) lines.push(`<span class="small muted">${esc(d.storeName)}</span>`);
    if (d.asset) lines.push(`<span class="small muted">${esc(d.asset)}</span>`);
    if (d.entrance) lines.push(`<span class="small muted">${esc(d.entrance)}</span>`);
    return lines.join('<br>');
  }

  const rows = pageRows.map((d) => {
    const isExcluded = excludedSet.has(d.deviceId);
    // Connectivity badge is computed from status.ts staleness server-side (iot-sync), NOT the
    // State column - State is the vendor's last self-reported analytics mode and stays frozen at
    // whatever it was doing when the device actually went dark, so it's never a reliable "is this
    // thing actually reachable" signal on its own (confirmed: real devices offline for months
    // still show State values like "Ready"/"Tracking"/"Idle", never "Offline").
    const connBadge = d.online
      ? '<span class="badge b-blue">Online</span>'
      : '<span class="badge b-red">Offline</span>';
    return `<tr${isExcluded ? ' style="opacity:.55;"' : ''}>
      <td class="small">${esc(d.deviceId)}</td>
      <td>${esc(d.displayName || '-')}</td>
      <td class="small">${esc(d.macAddress || '-')}</td>
      <td class="small tleft">${venueCellHtml(d)}</td>
      <td class="small">${esc(d.platform)}</td>
      <td class="small">${esc(d.state)}</td>
      <td>${connBadge}</td>
      <td class="small">${d.lastSeenUtc ? esc(fmtRelativeTime(d.lastSeenUtc)) : 'never'}</td>
      <td>${admin ? `<button class="btn-sm" onclick="App.toggleIotDeviceExcluded('${esc(d.deviceId)}', ${!isExcluded})">${isExcluded ? 'Include' : 'Exclude'}</button>` : (isExcluded ? '<span class="small muted">Excluded</span>' : '')}</td>
    </tr>`;
  }).join('') || `<tr><td colspan="9"><div class="empty">No devices match.</div></td></tr>`;

  return `<div class="card">
    <div class="card-head" style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;">
      <div><h3>Devices</h3><div class="desc">${filtered.length} of ${devices.length} device(s) shown${excludedSet.size ? `, ${excludedSet.size} excluded from the charts above` : ''}.${admin ? ' Excluding a device drops it from every future sync too, not just this view.' : ''} Devices with no friendly name set on the vendor's side show their MAC address instead of a blank Name.</div></div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;">
        <select onchange="App.setIotDeviceFilter(this.value)" style="padding:6px 8px;border:1px solid var(--border);border-radius:8px;">
          <option value="active" ${filterMode === 'active' ? 'selected' : ''}>Active devices</option>
          <option value="all" ${filterMode === 'all' ? 'selected' : ''}>All devices</option>
          <option value="excluded" ${filterMode === 'excluded' ? 'selected' : ''}>Excluded only</option>
        </select>
        <input id="iot-device-search" placeholder="Search device ID, name, MAC, venue, store..." value="${esc(STATE.iotDeviceSearch || '')}" oninput="App.setIotDeviceSearch(this.value)" style="min-width:220px;padding:7px 10px;border:1px solid var(--border);border-radius:8px;">
      </div>
    </div>
    <div style="max-height:480px;overflow-y:auto;overflow-x:auto;">
      <table style="${FIXED_TABLE_STYLE}">
        <thead><tr>${sortTh('iotDevices', 'deviceId', 'Device ID', 14)}${sortTh('iotDevices', 'name', 'Name', 18)}${sortTh('iotDevices', 'mac', 'MAC Address', 15)}${sortTh('iotDevices', 'venue', 'Venue', venueColWidth, 'left')}${sortTh('iotDevices', 'platform', 'Platform', 12)}${sortTh('iotDevices', 'state', 'State', 10)}${sortTh('iotDevices', 'connectivity', 'Connectivity', 13)}${sortTh('iotDevices', 'lastSeen', 'Last Seen', 14)}<th style="width:9ch;"></th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    ${totalPages > 1 ? `<div style="display:flex;justify-content:center;gap:10px;align-items:center;margin-top:10px;">
      <button class="btn-sm" ${page === 0 ? 'disabled' : ''} onclick="App.setIotDevicePage(${page - 1})">Prev</button>
      <span class="small muted">Page ${page + 1} of ${totalPages}</span>
      <button class="btn-sm" ${page >= totalPages - 1 ? 'disabled' : ''} onclick="App.setIotDevicePage(${page + 1})">Next</button>
    </div>` : ''}
  </div>`;
}

// Per-location heatmap tiles for IoT, same visual language and click-to-see-offline behavior as
// the Broadsign/Grassfish consoles (see renderNetworkPanel above) - reuses the same sourceStats/
// heatmapColor/chain-merging logic against source='iot'/healthyField='iot_healthy_count', which
// iot-sync already populates once "Offline Status Values" is calibrated (Settings > Integrations).
// Purely additive on the IoT Panel: sits above the existing fleet-wide "Devices by ..." charts,
// which keep showing the vendor's raw device list regardless of whether this per-site view has
// data yet.
function renderIotSiteHeatmap() {
  const allLocations = loadData('locationsForNetworkPanel', listLocations);
  if (allLocations === null) return '';
  if (allLocations?.__error) return '';

  const source = 'iot';
  const healthyField = 'iot_healthy_count';
  const hidden = hiddenMemberIds(allLocations);
  const hasDataDirect = (l) => (l.location_sub_assets || []).some((sa) => sa.source === source) || !!l[healthyField];
  const hasData = (l) => (l.is_combined ? resolveMembers(l, allLocations).some(hasDataDirect) : hasDataDirect(l));
  const dataLocs = allLocations.filter((l) => !hidden.has(l.id) && hasData(l));
  if (!dataLocs.length) return '';

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
  <div class="card">
    <div class="card-head" style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;">
      <div><h3>Site Status Heatmap</h3><div class="desc">${dataLocs.length} location(s) with IoT data, colored by offline share - green = all online, red = high offline share. Locations that belong to the same chain are merged into one tile. Click a tile to see what's offline and raise a ticket.</div></div>
      <input id="net-search" placeholder="Search by venue/location or chain name..." value="${esc(STATE.networkSearch || '')}" oninput="App.setNetworkSearch(this.value)" style="min-width:220px;padding:7px 10px;border:1px solid var(--border);border-radius:8px;">
    </div>
    ${visibleTiles.length ? `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:10px;">${tiles}</div>` : `<div class="empty">No location or chain matches "${esc(STATE.networkSearch || '')}".</div>`}
  </div>`;
}

// Category-aggregated tiles straight from the device list's own data (no Asset Inventory/Location
// matching needed) - shown only when the location-matched heatmap above has nothing yet, which
// today means every deployment until IoT cameras get tagged Player Type = "IoT" with a matching
// Player Box ID in Asset Inventory (see renderIotSiteHeatmap).
// Replaces the old one-tile-per-site grouping (which flooded the grid with a separate tile per
// mall/station - every "Malls - X"/"Metro - X" venue got its own tile) with one tile per venue
// CATEGORY (Metro/Malls/In-Store/Outdoor/Other), aggregating every site within it - matches how the
// Broadsign/Grassfish heatmap merges same-chain locations into one tile above, just one level
// coarser since these devices aren't matched to a Location yet.
// Category comes from aiooSiteCategory() (src/lib/aiooSiteCategory.js), which reads the
// "Category - Venue Name" prefix convention confirmed in real device storeName data (venue only
// ever gets filled in via the same Asset Inventory match this view exists because of, so it's blank
// for every device right now - storeName carries the vendor's site label instead).
// Colored by real connectivity (device.online, computed server-side in iot-sync from status.ts
// staleness) - NOT device.state, which is the vendor's last self-reported analytics mode and
// stays frozen at whatever it was doing when the device actually went dark (confirmed against
// real data: 0 of 559 devices ever reported state "Offline", including ones stale for months).
function renderIotCategoryHeatmap(cfg) {
  const excludedSet = new Set(cfg.excludedDeviceIds || []);
  const activeDevices = (cfg.lastDevices || []).filter((d) => !excludedSet.has(d.deviceId));
  if (!activeDevices.length) return '';

  const byCategory = new Map(SITE_CATEGORIES.map((c) => [c, []]));
  activeDevices.forEach((d) => {
    const site = d.storeName || d.venue || 'Unassigned';
    byCategory.get(aiooSiteCategory(site)).push(d);
  });

  const search = (STATE.networkSearch || '').trim().toLowerCase();
  const populatedCategories = SITE_CATEGORIES.filter((c) => byCategory.get(c).length);
  const visibleCategories = search ? populatedCategories.filter((c) => c.toLowerCase().includes(search)) : populatedCategories;

  // A single blended hue (the old heatmapColor approach) made "60% offline" and "20% offline"
  // hard to tell apart at a glance - each tile now shows a two-segment online(green)/offline(red)
  // proportion bar instead, so the actual split reads directly rather than through an interpolated
  // color guess.
  const tiles = visibleCategories.map((category) => {
    const devices = byCategory.get(category);
    const offline = devices.filter((d) => !d.online).length;
    const total = devices.length;
    const online = total - offline;
    const onlinePct = total ? (online / total) * 100 : 0;
    const siteCount = new Set(devices.map((d) => d.storeName || d.venue || 'Unassigned')).size;
    const label = category === 'Other' ? 'Other / Unclassified' : category;
    const flag = category === 'Other' ? ` <span style="background:rgba(255,255,255,.18);border-radius:4px;padding:1px 5px;font-size:10px;font-weight:600;">check</span>` : '';
    return `<div style="background:#2a3441;border-radius:10px;padding:12px;color:#fff;min-height:96px;display:flex;flex-direction:column;justify-content:space-between;gap:9px;cursor:pointer;" onclick="App.openIotCategoryModal('${esc(category)}')" title="Click to see sites and devices">
      <div>
        <div style="font-size:13px;font-weight:700;line-height:1.3;">${esc(label)}${flag} <span style="font-weight:400;opacity:.8;">(${siteCount} site${siteCount === 1 ? '' : 's'})</span></div>
        <div style="font-size:11px;opacity:.85;margin-top:2px;"><span style="color:#5fd88f;">${online} online</span>, <span style="color:#f2857a;">${offline} offline</span> of ${total}</div>
      </div>
      <div style="height:8px;border-radius:4px;overflow:hidden;display:flex;background:rgba(255,255,255,.12);">
        ${online ? `<div style="width:${onlinePct.toFixed(1)}%;background:#1f9d55;"></div>` : ''}
        ${offline ? `<div style="width:${(100 - onlinePct).toFixed(1)}%;background:#c0392b;"></div>` : ''}
      </div>
    </div>`;
  }).join('');

  return `<div class="card">
    <div class="card-head" style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;">
      <div><h3>Devices by Category</h3><div class="desc">${activeDevices.length} device(s) across ${populatedCategories.length} categor${populatedCategories.length === 1 ? 'y' : 'ies'} - each tile's bar shows online (green) vs offline (red) share. "Other / Unclassified" is devices whose site name doesn't match a known venue category (Metro/Malls/In-Store/Outdoor) - review it for orphaned, demo, or stray devices. Click a tile to see its sites and drill into devices.</div></div>
      <input id="net-search" placeholder="Search by category..." value="${esc(STATE.networkSearch || '')}" oninput="App.setNetworkSearch(this.value)" style="min-width:220px;padding:7px 10px;border:1px solid var(--border);border-radius:8px;">
    </div>
    ${visibleCategories.length ? `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:10px;">${tiles}</div>` : `<div class="empty">No category matches "${esc(STATE.networkSearch || '')}".</div>`}
  </div>`;
}

// Standalone dashboard of whatever iot-sync last pulled live from the aioo IoT Admin Console -
// deliberately NOT matched against Asset Inventory/Locations for the fleet-wide charts below (that
// matching lives in iot-sync, and feeds the per-venue heatmap above instead) - this section just
// shows the fleet as the vendor's own API reports it, same as the "Devices by ..." dashboard in
// aioo's own console.
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

  // The location-matched heatmap only has data once Asset Inventory has these cameras tagged
  // Player Type = "IoT" with a matching Player Box ID (same prerequisite Broadsign/Grassfish
  // have) - falls back to the category-aggregated heatmap (Metro/Malls/In-Store/Outdoor/Other)
  // until then, so the page still shows a useful, offline-colored breakdown from day one.
  const siteHeatmap = renderIotSiteHeatmap() || renderIotCategoryHeatmap(c);

  if (!b || !b.totalDevices) {
    return `${statusBar}${siteHeatmap}<div class="card"><div class="empty">No live device data yet.${admin ? ' Configure the API in Settings, then Sync Now.' : ' Ask an Admin to configure this.'}</div></div>`;
  }

  return `${statusBar}
  ${siteHeatmap}
  <div class="small muted" style="margin:10px 0 8px;">${b.totalDevices} device${b.totalDevices === 1 ? '' : 's'} in the fleet as of ${c.lastSync ? new Date(c.lastSync).toLocaleString() : 'last sync'}.</div>
  <div class="bento-grid">
    ${renderIotChartCard('Devices by Connectivity', donutItems(b.byConnectivity), 5, connectivityColor)}
    ${renderIotChartCard('Devices by Platform', donutItems(b.byPlatform), 0)}
    ${renderIotChartCard('Devices by State', canonicalStateItems(b.byState), 1)}
    ${renderIotChartCard('Devices by Camera Type', donutItems(b.byCameraType), 2)}
    ${renderIotChartCard('Devices by Version', donutItems(b.byVersion), 3)}
  </div>
  ${renderIotDeviceTable(c)}`;
}

export function openOfflineAssetsModal(opts) {
  openModal('offlineAssetsModal', opts);
}

export function openGrassfishVenueModal(venue) {
  openModal('grassfishVenueModal', { venue });
}

export function openIotCategoryModal(category) {
  openModal('iotCategoryModal', { category });
}

// Jumps to the existing Devices table (below the heatmap and 4 chart cards on the IoT Panel)
// pre-filtered to one site, rather than building a second nested device-list modal - "All" so a
// site with only excluded/offline devices isn't hidden by the default "Active devices" filter.
// The filter itself applies instantly, but render() deliberately preserves .content's scrollTop
// across every re-render (see state.js) - closing the modal and filtering the table both leave
// the page exactly where it already was, which on a long IoT Panel is nowhere near the table, so
// the search looked like it did nothing. setState() runs render() synchronously, so the table (and
// its search box) already exists in the DOM by the time scrollIntoView runs here.
export function viewIotSiteDevices(site) {
  closeModal();
  setState({ iotDeviceSearch: site, iotDevicePage: 0, iotDeviceFilter: 'all' });
  document.getElementById('iot-device-search')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
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

// Cross-references a Broadsign/Grassfish screen with the PC that drives it, via the same Player
// Box ID both the sync functions AND the Digital Directory agent match on (see
// defaultCollectorScript() in settings.js) - lets an offline-screen row here offer a direct
// AnyDesk/TeamViewer connect option instead of a separate trip to the Digital Directory page.
// Matches against EITHER id field regardless of which console the row came from - a PC's Digital
// Directory entry isn't guaranteed to have its id recorded under the field matching this specific
// page's source, so checking both catches it either way. Best-effort: returns an empty map (no
// chips shown) if the viewer can't see workspace_devices at all, same as loadData() failing
// silently elsewhere - Digital Directory isn't guaranteed to be configured/populated.
function deviceByBoxId() {
  const devices = loadData('workspaceDevicesForNetworkPanel', listWorkspaceDevices);
  const map = new Map();
  if (!Array.isArray(devices)) return map;
  devices.forEach((d) => {
    const bId = (d.broadsign_player_id || '').trim();
    const gId = (d.grassfish_box_id || '').trim();
    if (bId) map.set(bId, d);
    if (gId) map.set(gId, d);
  });
  return map;
}

// One compact "Remote Access" button (same size/style as the "+ Ticket" button beside it) instead
// of a separate AnyDesk/TeamViewer chip per row - keeps this column from growing with every extra
// remote-access tool a PC happens to have (see Get-AllAnyDeskIds), same idea as collapsing a long
// menu behind one button rather than listing every option inline. Clicking it opens a small picker
// to choose which tool to connect with.
function remoteAccessOptionsFor(device) {
  if (!device) return [];
  const tools = [];
  if (device.anydesk_id) tools.push({ tool: 'AnyDesk', id: device.anydesk_id, url: remoteAccessUrl('AnyDesk', device.anydesk_id) });
  if (device.teamviewer_id) tools.push({ tool: 'TeamViewer', id: device.teamviewer_id, url: remoteAccessUrl('TeamViewer', device.teamviewer_id) });
  (device.other_remote_ids || []).forEach((r) => {
    const url = remoteAccessUrl(r.tool, r.id);
    if (url) tools.push({ tool: r.tool, id: r.id, url });
  });
  return tools;
}

function remoteAccessButtonHtml(device, label) {
  const tools = remoteAccessOptionsFor(device);
  if (!tools.length) return '<span class="small muted">-</span>';
  return `<button class="btn-sm" onclick='App.openRemoteAccessPicker(${jsonAttr({ tools, label: label || '' })})'>Remote Access</button>`;
}

registerModal('remoteAccessPicker', (data) => {
  const tools = data.tools || [];
  const rows = tools.map((t) => `<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;padding:8px 0;border-bottom:1px solid var(--border);">
    <span><b>${esc(t.tool)}</b> <span style="font-family:monospace;" class="small muted">${esc(t.id)}</span></span>
    <span style="display:flex;gap:6px;">
      <a class="btn-sm" style="text-decoration:none;" href="${t.url || ''}" title="Connect via ${esc(t.tool)}" onclick="App.closeModal()">Connect</a>
      <button type="button" class="btn-sm" title="Copy ID" onclick="App.copyWorkspaceId(event,'${esc(t.id)}')">Copy</button>
    </span>
  </div>`).join('');
  return `
    <h3>Remote Access${data.label ? ` - ${esc(data.label)}` : ''}</h3>
    <div>${rows || '<div class="empty">No remote access tool detected.</div>'}</div>
    <div class="modal-actions"><button class="btn-sm" onclick="App.closeModal()">Close</button></div>
  `;
});

export function openRemoteAccessPicker(data) {
  openModal('remoteAccessPicker', data);
}

registerModal('offlineAssetsModal', (data) => {
  const allLocations = STATE.pageData.locationsForNetworkPanel?.data || [];
  const ticketAddOk = canAdd('tickets');
  const sourceLabel = data.source === 'broadsign' ? 'Broadsign Console' : data.source === 'grassfish' ? 'Grassfish Console' : '';
  const boxIdMap = deviceByBoxId();

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
    const device = i.boxId ? boxIdMap.get(i.boxId) : null;
    return `<tr><td>${esc(i.location)}</td><td>${esc(i.name)}</td><td>${esc(i.detail || '')}</td><td>${remoteAccessButtonHtml(device, i.name)}</td><td>${ticketAddOk ? `<button class="btn-sm" onclick='App.openTicketFromOffline(${jsonAttr(prefill)})'>+ Ticket</button>` : ''}</td></tr>`;
  }).join('') || `<tr><td colspan="5"><div class="empty">Nothing offline here.</div></td></tr>`;

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
    <div style="max-height:60vh;overflow-y:auto;overflow-x:auto;">
      <table style="${FIXED_TABLE_STYLE}">
        <thead><tr><th style="width:16ch;">Location</th><th style="width:18ch;">Name</th><th style="width:26ch;">Detail</th><th style="width:12ch;">Remote Access</th><th style="width:9ch;"></th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <div class="modal-actions">
      ${(ticketAddOk && bulkPrefill && items.length > 1) ? `<button class="btn-sm" onclick='App.openTicketFromOffline(${jsonAttr(bulkPrefill)})'>Create Ticket for All</button>` : ''}
      <button class="btn-sm" onclick="App.closeModal()">Close</button>
    </div>
  `;
}, { wide: true });

registerModal('iotCategoryModal', (data) => {
  const category = data.category;
  const cfg = STATE.pageData.iotApi?.data || {};
  const excludedSet = new Set(cfg.excludedDeviceIds || []);
  const devices = (cfg.lastDevices || []).filter((d) => !excludedSet.has(d.deviceId) && aiooSiteCategory(d.storeName || d.venue || 'Unassigned') === category);

  const bySite = new Map();
  devices.forEach((d) => {
    const site = d.storeName || d.venue || 'Unassigned';
    if (!bySite.has(site)) bySite.set(site, []);
    bySite.get(site).push(d);
  });
  const siteRows = [...bySite.keys()].map((site) => {
    const list = bySite.get(site);
    return { site, count: list.length, offline: list.filter((d) => !d.online).length };
  });
  const sortedSites = applySort(siteRows, 'iotCategorySites', {
    site: (s) => aiooSiteDisplayName(s.site) || '',
    devices: (s) => s.count,
    offline: (s) => s.offline,
  });

  const rows = sortedSites.map(({ site, count, offline }) => `<tr>
      <td>${esc(aiooSiteDisplayName(site))}</td>
      <td class="tright">${count}</td>
      <td class="tright">${offline}</td>
      <td><button class="btn-sm" onclick='App.viewIotSiteDevices(${jsonAttr(site)})'>View devices</button></td>
    </tr>`).join('') || `<tr><td colspan="4"><div class="empty">No sites in this category.</div></td></tr>`;

  const label = category === 'Other' ? 'Other / Unclassified' : category;
  return `
    <h3>${esc(label)} - ${devices.length} device(s)</h3>
    ${category === 'Other' ? `<p class="small muted">These sites didn't match a known venue category (Metro/Malls/In-Store/Outdoor) or a known retail-chain name - likely orphaned, demo, or test devices rather than real venues. Review them below and exclude any that shouldn't count toward the fleet (Devices table on the main IoT Panel).</p>` : ''}
    <table style="${FIXED_TABLE_STYLE}">
      <thead><tr>${sortTh('iotCategorySites', 'site', 'Site')}${sortTh('iotCategorySites', 'devices', 'Devices', 10)}${sortTh('iotCategorySites', 'offline', 'Offline', 10)}<th style="width:12ch;"></th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <div class="modal-actions"><button class="btn-sm" onclick="App.closeModal()">Close</button></div>
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
    <div style="max-height:60vh;overflow-y:auto;overflow-x:auto;">
      <table style="${FIXED_TABLE_STYLE}">
        <thead><tr><th style="width:22ch;">Name</th><th style="width:16ch;">Format</th>${admin ? '<th style="width:18ch;">Player Box ID</th>' : ''}<th style="width:9ch;"></th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <div class="modal-actions"><button class="btn-sm" onclick="App.closeModal()">Close</button></div>
  `;
});

export function openTicketFromOffline(prefill) {
  openModal('ticket', { ...prefill, date_reported: new Date().toISOString().slice(0, 10), status: 'Open' });
}
