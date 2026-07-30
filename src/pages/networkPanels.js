import { STATE, loadData, invalidate, openModal, toast, setState } from '../state.js';
import { loadingCard, registerModal } from '../modals.js';
import { getSetting } from '../data/settings.js';
import { listLocations } from '../data/locations.js';
import { listAssetInventory } from '../data/assetsInventory.js';
import { hiddenMemberIds, resolveMembers, sourceStats, heatmapColor } from '../data/locationStats.js';
import { supabase } from '../supabaseClient.js';
import { isAdmin, canAdd } from '../auth.js';
import { logAudit } from '../lib/audit.js';
import { esc } from '../lib/format.js';

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

  return `<div class="banner" style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;">
    <span>${c.baseUrl ? `API configured (${esc(c.baseUrl)})${c.lastSync ? `, last tested ${esc(c.lastSync)}` : ', not tested yet'}.` : 'No live API configured yet.'} ${dataLocs.length ? `Showing the last imported snapshot for ${dataLocs.length} location(s), pulled from Locations.` : 'No data imported for this source yet.'}</span>
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

  return `<div class="banner" style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;">
    <span>${c.baseUrl ? `API configured (${esc(c.baseUrl)})${c.lastSync ? `, last tested ${esc(c.lastSync)}` : ', not tested yet'}.` : 'No live API configured yet.'} ${screens.length} Grassfish screen${screens.length === 1 ? '' : 's'} across ${venues.length} venue${venues.length === 1 ? '' : 's'} in Asset Inventory. This view reflects Asset Inventory directly (Player Type = Grassfish) rather than a live online/offline feed - once a sync succeeds at least once, this page switches to the same online/offline heatmap the Broadsign Console uses.</span>
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

// Until iot-sync has run at least once with Status Field Name/Offline Status Values calibrated
// (see Settings > Integrations > IoT Admin Console), no location has a location_sub_assets row
// sourced from IoT yet - same "fall back to an Asset Inventory view" pattern the Grassfish panel
// uses, so this stays useful rather than permanently empty.
export function renderIotPanel() {
  const allLocations = loadData('locationsForNetworkPanel', listLocations);
  if (allLocations === null) return loadingCard();
  if (allLocations?.__error) return loadingCard(allLocations.__error);
  const hasLiveData = allLocations.some((l) => (l.location_sub_assets || []).some((sa) => sa.source === 'iot'));
  if (hasLiveData) {
    return renderNetworkPanel('iot', 'iot_healthy_count', 'IoT Panel', 'iotApi', 'iot-sync');
  }

  const cfg = loadData('iotApi', () => getSetting('iotApi'));
  const inventory = loadData('assetInventoryForIotPanel', listAssetInventory);
  if (cfg === null || inventory === null) return loadingCard();
  if (cfg?.__error) return loadingCard(cfg.__error);
  if (inventory?.__error) return loadingCard(inventory.__error);

  const admin = isAdmin();
  const c = cfg || {};
  const devices = inventory.filter((r) => r.player_type === 'IoT');
  const byVenue = {};
  devices.forEach((r) => {
    const v = r.venue || 'Unassigned';
    if (!byVenue[v]) byVenue[v] = [];
    byVenue[v].push(r);
  });
  const venues = Object.keys(byVenue).sort((a, b) => a.localeCompare(b));
  const search = (STATE.networkSearch || '').trim().toLowerCase();
  const visibleVenues = search ? venues.filter((v) => v.toLowerCase().includes(search)) : venues;
  const tiles = visibleVenues.map((v) => {
    const list = byVenue[v];
    return `<div style="background:#5a4fb0;border-radius:10px;padding:12px;color:#fff;min-height:90px;display:flex;flex-direction:column;justify-content:space-between;cursor:pointer;" onclick='App.openIotVenueModal(${jsonAttr(v)})' title="Click to see devices at this venue">
      <div style="font-size:12.5px;font-weight:700;line-height:1.3;">${esc(v)}</div>
      <div style="font-size:11px;opacity:.95;">${list.length} device${list.length === 1 ? '' : 's'}</div>
    </div>`;
  }).join('');

  return `<div class="banner" style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;">
    <span>${c.baseUrl ? `API configured (${esc(c.baseUrl)})${c.lastSync ? `, last tested ${esc(c.lastSync)}` : ', not tested yet'}.` : 'No live API configured yet.'} ${devices.length} IoT device${devices.length === 1 ? '' : 's'} across ${venues.length} venue${venues.length === 1 ? '' : 's'} in Asset Inventory. This view reflects Asset Inventory directly (Player Type = IoT) rather than a live online/offline feed - once a sync succeeds at least once, this page switches to the same online/offline heatmap the Broadsign/Grassfish Consoles use.</span>
    <span style="display:flex;gap:8px;flex-wrap:wrap;">
      <button class="btn-sm" onclick="App.runNetworkSync('iotApi','iot-sync')" ${STATE.syncing === 'iotApi' ? 'disabled' : ''}>${STATE.syncing === 'iotApi' ? 'Syncing...' : 'Sync Now'}</button>
      ${admin ? `<button class="btn-sm" onclick="App.setPage('settings')">Configure API</button>` : ''}
    </span>
  </div>
  ${venues.length ? `<div class="card">
    <div class="card-head" style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;">
      <div><h3>Devices by Venue</h3><div class="desc">One tile per venue with at least one IoT device in Asset Inventory. Click a tile to see the individual devices and raise a ticket if needed.</div></div>
      <input id="net-search" placeholder="Search by venue name..." value="${esc(STATE.networkSearch || '')}" oninput="App.setNetworkSearch(this.value)" style="min-width:220px;padding:7px 10px;border:1px solid var(--border);border-radius:8px;">
    </div>
    ${visibleVenues.length ? `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:10px;">${tiles}</div>` : `<div class="empty">No venue matches "${esc(STATE.networkSearch || '')}".</div>`}
  </div>` : `<div class="card"><div class="empty">No devices tagged Player Type = IoT in Asset Inventory yet. Set a device's Player Type to "IoT" under Asset Inventory to have it show up here.</div></div>`}`;
}

export function openIotVenueModal(venue) {
  openModal('iotVenueModal', { venue });
}

registerModal('iotVenueModal', (data) => {
  const venue = data.venue || '';
  const inventory = STATE.pageData.assetInventoryForIotPanel?.data || [];
  const devices = inventory.filter((r) => r.player_type === 'IoT' && (r.venue || '') === venue);
  const ticketAddOk = canAdd('tickets');
  const rows = devices.map((r) => {
    const prefill = {
      title: `${venue} - ${r.name} Issue`,
      location: venue,
      description: `Device: ${r.name}${r.format ? ` (${r.format})` : ''}${r.player_box_id ? ` - Player Box ID: ${r.player_box_id}` : ''}`,
      type: 'Issue',
    };
    return `<tr>
      <td><b>${esc(r.name)}</b></td>
      <td>${esc(r.format || '-')}${r.width && r.height ? `<div class="small muted">${r.width}x${r.height}</div>` : ''}</td>
      <td>${esc(r.player_box_id || '-')}</td>
      <td>${ticketAddOk ? `<button class="btn-sm" onclick='App.openTicketFromOffline(${jsonAttr(prefill)})'>+ Ticket</button>` : ''}</td>
    </tr>`;
  }).join('') || `<tr><td colspan="4"><div class="empty">No IoT devices at this venue.</div></td></tr>`;
  return `
    <h3>IoT - ${esc(venue)}</h3>
    <div class="small muted" style="margin-bottom:8px;">${devices.length} device${devices.length === 1 ? '' : 's'} at this venue, pulled from Asset Inventory (Player Type = IoT).</div>
    <table>
      <thead><tr><th>Name</th><th>Format</th><th>Player Box ID</th><th></th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <div class="modal-actions"><button class="btn-sm" onclick="App.closeModal()">Close</button></div>
  `;
});

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
    invalidate('assetInventoryForIotPanel');
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
      <td>${esc(r.player_box_id || '-')}</td>
      <td>${ticketAddOk ? `<button class="btn-sm" onclick='App.openTicketFromOffline(${jsonAttr(prefill)})'>+ Ticket</button>` : ''}</td>
    </tr>`;
  }).join('') || `<tr><td colspan="4"><div class="empty">No Grassfish screens at this venue.</div></td></tr>`;
  return `
    <h3>Grassfish - ${esc(venue)}</h3>
    <div class="small muted" style="margin-bottom:8px;">${screens.length} screen${screens.length === 1 ? '' : 's'} at this venue, pulled from Asset Inventory (Player Type = Grassfish).</div>
    <table>
      <thead><tr><th>Name</th><th>Format</th><th>Player Box ID</th><th></th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <div class="modal-actions"><button class="btn-sm" onclick="App.closeModal()">Close</button></div>
  `;
});

export function openTicketFromOffline(prefill) {
  openModal('ticket', { ...prefill, date_reported: new Date().toISOString().slice(0, 10), status: 'Open' });
}
