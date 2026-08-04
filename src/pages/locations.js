import { STATE, loadData, invalidate, openModal, closeModal, toast, setState } from '../state.js';
import { loadingCard, registerModal } from '../modals.js';
import { canAdd, canEdit, canDelete, canExportArea, isAdmin } from '../auth.js';
import {
  listLocations, saveLocation, deleteLocation, setManualAssetInventoryIds, combineLocations,
} from '../data/locations.js';
import { listAssetInventory } from '../data/assetsInventory.js';
import { getSetting, saveSetting } from '../data/settings.js';
import {
  hiddenMemberIds, resolveMembers, heatmapColor, screenDensityColor,
  locationScreenCount, guessEmirate, EMIRATES_ORDER, sortByTileOrder, assetInventoryForLocation,
  brandNameForLocation,
} from '../data/locationStats.js';
import { svgGroupedBarChart } from '../lib/charts.js';
import { heatmapGrid } from '../lib/heatmapGrid.js';
import { sortTh, applySort } from '../lib/sortableTable.js';
import { renderTabs } from '../lib/tabs.js';
import { brandLogoTag } from '../lib/brandLogo.js';
import { exportToCsv } from '../lib/csv.js';
import { logAudit } from '../lib/audit.js';
import { esc } from '../lib/format.js';

let draggedVenueId = null;

// Every location mutation here (save/delete/combine/bulk-add/manual-link) only ever invalidated
// this page's own 'locationsPage' cache - the Broadsign/Grassfish/IoT Console pages independently
// cache the same listLocations() data under 'locationsForNetworkPanel', and several other pages
// (Tickets, SIM Cards, Hardware Inventory, Procurement, Live Ops, Settings) bundle it into their
// own page-scoped cache key. None of those got busted, so e.g. combining two locations on this
// page never showed up on the Broadsign Console until either its 2-minute cache TTL happened to
// expire or the whole app was reloaded - easy to read as "the combined tile just doesn't work."
// Same "invalidate every bundle this data appears in" pattern as assetsInventory.js's
// invalidateAssetInventoryCaches().
function invalidateLocationCaches() {
  invalidate('locationsPage');
  invalidate('locationsForNetworkPanel');
  invalidate('assets');
  invalidate('opsOverviewV2');
  invalidate('procurementPage');
  invalidate('settings');
  invalidate('simCardsPage');
  invalidate('ticketsPage');
}

async function loadLocationsData() {
  const [locations, assetInventory, venueTileOrder] = await Promise.all([
    listLocations(), listAssetInventory(), getSetting('venueTileOrder'),
  ]);
  return { locations, assetInventory, venueTileOrder: venueTileOrder || [] };
}

function pageData() {
  return STATE.pageData.locationsPage?.data;
}

export function renderLocations() {
  const data = loadData('locationsPage', loadLocationsData);
  if (data === null) return loadingCard();
  if (data.__error) return loadingCard(data.__error);

  const { locations, assetInventory } = data;
  const hidden = hiddenMemberIds(locations);
  const visible = locations.filter((l) => !hidden.has(l.id));

  const view = STATE.locationView || 'venues';
  const emirateFilter = STATE.locationEmirateFilter || '';
  const chainFilter = STATE.locationChainFilter || '';
  const search = (STATE.locationSearch || '').trim().toLowerCase();
  const chains = [...new Set(locations.map((l) => l.chain).filter(Boolean))].sort();

  const filtered = visible.filter((l) => {
    if (emirateFilter && guessEmirate(l) !== emirateFilter) return false;
    if (chainFilter && l.chain !== chainFilter) return false;
    if (search && !l.name.toLowerCase().includes(search)) return false;
    return true;
  });

  const tabsHtml = renderTabs([
    { key: 'venues', label: 'Venues' }, { key: 'list', label: 'List' }, { key: 'heatmap', label: 'Heatmap' },
  ], view, 'App.setLocationView');

  let body;
  if (view === 'list') body = renderListView(filtered, locations, assetInventory);
  else if (view === 'heatmap') body = renderHeatmapView(filtered, locations, assetInventory);
  else body = renderVenuesView(filtered, data.venueTileOrder);

  return `
    ${renderCharts(visible, locations, assetInventory)}
    <div class="banner">Online/offline network health has moved to the dedicated Broadsign and Grassfish Console pages — this heatmap reflects screen density from Asset Inventory.</div>
    <div class="toolbar">
      ${tabsHtml}
      <div class="toolbar-actions">
        <select onchange="App.setLocationEmirateFilter(this.value)">
          <option value="">All Emirates</option>
          ${EMIRATES_ORDER.filter((e) => e !== 'Unspecified').map((e) => `<option value="${e}" ${emirateFilter === e ? 'selected' : ''}>${e}</option>`).join('')}
        </select>
        ${chains.length ? `
          <select onchange="App.setLocationChainFilter(this.value)">
            <option value="">All Chains</option>
            ${chains.map((c) => `<option value="${esc(c)}" ${chainFilter === c ? 'selected' : ''}>${esc(c)}</option>`).join('')}
          </select>
        ` : ''}
        <input id="loc-search" placeholder="Search locations..." value="${esc(STATE.locationSearch || '')}" oninput="App.setLocationSearch(this.value)">
        ${canExportArea('locations') ? `<button class="btn-sm" onclick="App.exportLocationsCsv()">Export CSV</button>` : ''}
        ${isAdmin() ? `<button class="btn-sm" onclick="App.openBulkImport('locations')">Bulk Import</button>` : ''}
        ${canEdit('locations') ? `<button class="btn-sm" onclick="App.openCombineLocationsModal()">+ Combine Locations</button>` : ''}
        ${canAdd('locations') ? `<button class="btn-sm" onclick="App.openUnassignedAssetsModal()">Unassigned Assets</button>` : ''}
        ${canAdd('locations') ? `<button class="btn-sm" onclick="App.openBulkAddLocationsModal()">+ Bulk Add Locations</button>` : ''}
        ${canAdd('locations') ? `<button class="btn btn-orange" onclick="App.editLocation(null)">+ Add Location</button>` : ''}
      </div>
    </div>
    ${(view === 'venues' || view === 'list') ? renderLocationSelectionBanner() : ''}
    ${body}
  `;
}

function renderLocationSelectionBanner() {
  const count = (STATE.locSelectedIds || []).length;
  if (!count) return '';
  return `<div class="banner" style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;">
    <span><b>${count}</b> location${count === 1 ? '' : 's'} selected</span>
    <div style="display:flex;gap:8px;">
      ${canDelete('locations') ? `<button class="btn-sm" style="color:#c0392b;" onclick="App.bulkDeleteLocations()">Delete Selected</button>` : ''}
      <button class="btn-sm" onclick="App.clearLocationSelection()">Clear Selection</button>
    </div>
  </div>`;
}

export function setLocationView(v) { setState({ locationView: v }); }
export function setLocationEmirateFilter(v) { setState({ locationEmirateFilter: v }); }
export function setLocationChainFilter(v) { setState({ locationChainFilter: v }); }
export function setLocationSearch(v) { setState({ locationSearch: v }); }

// -------------------- bulk selection (Venues + List views) --------------------
export function toggleLocationSelection(id, checked) {
  const cur = new Set(STATE.locSelectedIds || []);
  if (checked) cur.add(id); else cur.delete(id);
  setState({ locSelectedIds: [...cur] });
}
export function toggleLocationSelectGroup(ids, checked) {
  const cur = new Set(STATE.locSelectedIds || []);
  ids.forEach((id) => { if (checked) cur.add(id); else cur.delete(id); });
  setState({ locSelectedIds: [...cur] });
}
export function clearLocationSelection() { setState({ locSelectedIds: [] }); }

export async function bulkDeleteLocations() {
  const ids = STATE.locSelectedIds || [];
  if (!ids.length) return;
  if (!confirm(`Move ${ids.length} location(s) to the Recycle Bin?`)) return;
  try {
    for (const id of ids) await deleteLocation(id);
    await logAudit('Bulk delete locations', `${ids.length} location(s)`);
    invalidateLocationCaches();
    setState({ locSelectedIds: [] });
    toast(`${ids.length} location(s) deleted`);
  } catch (e) { toast(e.message, 'error'); }
}

// -------------------- charts --------------------
function renderCharts(visible, allLocations, assetInventory) {
  const withCounts = visible.map((l) => ({ l, count: locationScreenCount(l, allLocations, assetInventory) }));
  const topVenues = [...withCounts].sort((a, b) => b.count - a.count).slice(0, 8);

  const byEmirate = {};
  for (const { l, count } of withCounts) {
    const em = guessEmirate(l);
    byEmirate[em] = byEmirate[em] || { venues: 0, screens: 0 };
    byEmirate[em].venues++;
    byEmirate[em].screens += count;
  }
  const emirateEntries = Object.entries(byEmirate).sort((a, b) => b[1].screens - a[1].screens);

  return `
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:14px;margin-bottom:20px;">
      <div class="card" style="margin-bottom:0;">
        <div class="card-head"><h3>Top Venues by Screen Count</h3></div>
        ${svgGroupedBarChart(topVenues.map((v) => v.l.name), [{ name: 'Screens', color: '#c0392b', values: topVenues.map((v) => v.count) }])}
      </div>
      <div class="card" style="margin-bottom:0;">
        <div class="card-head"><h3>Venues &amp; Screens by Emirate</h3></div>
        ${svgGroupedBarChart(emirateEntries.map((e) => e[0]), [
          { name: 'Venues', color: '#3a7ca5', values: emirateEntries.map((e) => e[1].venues) },
          { name: 'Screens', color: '#e07a2c', values: emirateEntries.map((e) => e[1].screens) },
        ])}
      </div>
    </div>
  `;
}

// -------------------- venues (card grid, drag-drop) --------------------
function renderVenuesView(filtered, venueTileOrder) {
  const editOk = canEdit('locations');
  const bulkOk = canDelete('locations');
  const ordered = sortByTileOrder(filtered, venueTileOrder);
  const selected = new Set(STATE.locSelectedIds || []);
  const allSelected = ordered.length > 0 && ordered.every((l) => selected.has(l.id));
  const cards = ordered.map((l) => venueCardHtml(l, editOk, bulkOk, selected.has(l.id))).join('');
  return `
    <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;margin-bottom:10px;">
      ${editOk ? '<p class="small muted" style="margin:0;">Drag the ⋮⋮ handle on a tile to reorder Venues. Your order is saved automatically.</p>' : '<span></span>'}
      ${bulkOk && ordered.length ? `<label style="display:flex;align-items:center;gap:6px;font-size:12.5px;font-weight:600;color:var(--text-dim);"><input type="checkbox" style="width:auto;" ${allSelected ? 'checked' : ''} onchange="App.toggleLocationSelectGroup(${JSON.stringify(ordered.map((l) => l.id))}, this.checked)">Select all visible</label>` : ''}
    </div>
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:14px;">
      ${cards || '<div class="empty">No locations match your filters.</div>'}
    </div>
  `;
}

function venueCardHtml(l, editOk, bulkOk, isSelected) {
  const data = pageData();
  const screenCount = locationScreenCount(l, data.locations, data.assetInventory);
  const members = l.is_combined ? resolveMembers(l, data.locations) : [];
  const dragAttrs = editOk
    ? `draggable="true" ondragstart="App.onVenueDragStart(event,'${l.id}')" ondragend="App.onVenueDragEnd(event)" ondragover="event.preventDefault()" ondrop="App.onVenueDrop(event,'${l.id}')"`
    : '';
  return `
    <div class="card" style="margin-bottom:0;cursor:pointer;" ${dragAttrs} onclick="App.openVenueDetail('${l.id}')">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;">
        <div>
          ${bulkOk ? `<input type="checkbox" style="width:auto;margin-right:6px;" ${isSelected ? 'checked' : ''} onclick="event.stopPropagation()" onchange="App.toggleLocationSelection('${l.id}', this.checked)">` : ''}
          ${editOk ? '<span style="cursor:grab;color:var(--text-dim);">⋮⋮</span> ' : ''}${brandLogoTag(brandNameForLocation(l))} <strong>${esc(l.name)}</strong>
          ${l.is_combined ? ' <span class="badge b-blue">Combined</span>' : ''}
        </div>
        <span class="badge ${l.type === 'Installed' ? 'b-green' : 'b-gray'}">${esc(l.type)}</span>
      </div>
      <div class="small muted" style="margin-top:6px;">${esc(l.address || '')}</div>
      <div class="small" style="margin-top:8px;">${screenCount} screens matched from Asset Inventory${members.length ? ` across ${members.length} member location(s)` : ''}</div>
      ${l.notes ? `<div class="small muted" style="margin-top:4px;">${esc(l.notes)}</div>` : ''}
      <div style="margin-top:10px;display:flex;gap:6px;">
        ${canEdit('locations') ? `<button class="btn-sm" onclick="event.stopPropagation();App.editLocation('${l.id}')">Edit</button>` : ''}
        ${canDelete('locations') ? `<button class="btn-sm" onclick="event.stopPropagation();App.removeLocation('${l.id}')">Delete</button>` : ''}
      </div>
    </div>
  `;
}

export function onVenueDragStart(event, id) {
  draggedVenueId = id;
  event.currentTarget.style.opacity = '0.5';
}
export function onVenueDragEnd(event) {
  event.currentTarget.style.opacity = '';
}
export async function onVenueDrop(event, targetId) {
  event.preventDefault();
  if (!draggedVenueId || draggedVenueId === targetId) { draggedVenueId = null; return; }
  const data = pageData();
  if (!data) return;
  const hidden = hiddenMemberIds(data.locations);
  const visible = data.locations.filter((l) => !hidden.has(l.id));
  const ordered = sortByTileOrder(visible, data.venueTileOrder).map((l) => l.id);
  const fromIdx = ordered.indexOf(draggedVenueId);
  if (fromIdx === -1) { draggedVenueId = null; return; }
  ordered.splice(fromIdx, 1);
  const toIdx = ordered.indexOf(targetId);
  ordered.splice(toIdx === -1 ? ordered.length : toIdx, 0, draggedVenueId);
  draggedVenueId = null;
  try {
    await saveSetting('venueTileOrder', ordered);
    invalidateLocationCaches();
    setState({});
  } catch (e) { toast(e.message, 'error'); }
}

// -------------------- heatmap --------------------
function renderHeatmapView(filtered, allLocations, assetInventory) {
  const withCounts = filtered.map((l) => ({ l, count: locationScreenCount(l, allLocations, assetInventory) }));
  const maxCount = Math.max(1, ...withCounts.map((w) => w.count));
  return `
    <div class="card">
      <div class="card-head"><h3>Site Status Heatmap</h3><div class="desc">Colored by screen density (Asset Inventory match count)</div></div>
      ${heatmapGrid(withCounts, {
        colorFn: (w) => screenDensityColor(w.count, maxCount),
        textColorFn: (w) => (maxCount ? (w.count / maxCount <= 0.55 ? '#3a2f22' : '#fff') : '#3a2f22'),
        contentHtml: (w) => `<div style="font-weight:700;font-size:12.5px;">${esc(w.l.name)}${w.l.is_combined ? ' (combined)' : ''}</div><div style="font-size:11px;margin-top:4px;">${w.count} screens</div>`,
        onClick: (w) => `App.openVenueDetail('${w.l.id}')`,
      })}
    </div>
  `;
}

// -------------------- list view --------------------
function renderListView(filtered, allLocations, assetInventory) {
  const bulkOk = canDelete('locations');
  const selected = new Set(STATE.locSelectedIds || []);
  const grouped = {};
  for (const l of filtered) {
    const em = guessEmirate(l);
    grouped[em] = grouped[em] || [];
    grouped[em].push(l);
  }
  const sections = EMIRATES_ORDER.filter((em) => grouped[em]?.length).map((em) => {
    const rows = applySort(grouped[em], 'locationsList', {
      name: (l) => l.name,
      address: (l) => l.address || '',
      screens: (l) => locationScreenCount(l, allLocations, assetInventory),
    });
    const groupIds = rows.map((l) => l.id);
    const allGroupSelected = groupIds.length > 0 && groupIds.every((id) => selected.has(id));
    return `
      <details open class="card">
        <summary style="cursor:pointer;font-weight:700;">${esc(em)} (${grouped[em].length})</summary>
        <table style="margin-top:10px;">
          <thead><tr>${bulkOk ? `<th style="width:28px;"><input type="checkbox" ${allGroupSelected ? 'checked' : ''} onchange="App.toggleLocationSelectGroup(${JSON.stringify(groupIds)}, this.checked)" title="Select all in ${esc(em)}"></th>` : ''}${sortTh('locationsList', 'name', 'Venue')}${sortTh('locationsList', 'address', 'Address')}${sortTh('locationsList', 'screens', 'Screens')}<th></th></tr></thead>
          <tbody>
            ${rows.map((l) => `
              <tr>
                ${bulkOk ? `<td><input type="checkbox" ${selected.has(l.id) ? 'checked' : ''} onchange="App.toggleLocationSelection('${l.id}', this.checked)"></td>` : ''}
                <td>${esc(l.name)}</td>
                <td>${esc(l.address || '-')}</td>
                <td class="tright">${locationScreenCount(l, allLocations, assetInventory)}</td>
                <td>
                  ${canEdit('locations') ? `<button class="btn-sm" onclick="App.editLocation('${l.id}')">Edit</button>` : ''}
                  ${canDelete('locations') ? `<button class="btn-sm" onclick="App.removeLocation('${l.id}')">Delete</button>` : ''}
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </details>
    `;
  }).join('');
  return sections || '<div class="empty">No locations match your filters.</div>';
}

// -------------------- venue detail modal --------------------
export function openVenueDetail(id) {
  const data = pageData();
  const loc = data?.locations.find((l) => l.id === id);
  if (loc) openModal('venueDetail', { locationId: id });
}

// Every Asset Inventory row matched to a member location, auto (by venue name) + manually linked
// (via the Edit Location modal's linker), de-duplicated - matches the original's
// assetInventoryForLocation(loc), which is why manually-linked screens show up here even when
// their venue text doesn't match the location name.
function mergedItemsForMember(m, assetInventory) {
  const auto = assetInventoryForLocation(m.name, assetInventory);
  const manualIds = new Set(m.manual_asset_inventory_ids || []);
  const manual = assetInventory.filter((r) => manualIds.has(r.id));
  const seen = new Set();
  const merged = [];
  for (const r of [...auto, ...manual]) {
    if (!seen.has(r.id)) { seen.add(r.id); merged.push(r); }
  }
  return merged;
}

registerModal('venueDetail', (data) => {
  const pd = pageData();
  const loc = pd.locations.find((l) => l.id === data.locationId);
  if (!loc) return '<div class="empty">Location not found.</div>';
  const members = loc.is_combined ? resolveMembers(loc, pd.locations) : [loc];
  const editOk = canEdit('assetsInventory');
  const delOk = canDelete('assetsInventory');

  const groups = members.map((m) => {
    const items = mergedItemsForMember(m, pd.assetInventory);
    const screens = items.reduce((s, i) => s + (Number(i.screens) || 0), 0);
    const faces = items.reduce((s, i) => s + (Number(i.faces) || 0), 0);
    const rows = items.map((i) => {
      const label = [i.venue, i.location].filter(Boolean).join(' - ') || i.name;
      const specs = [i.screens ? `${i.screens} screen${i.screens === 1 ? '' : 's'}` : '', i.faces ? `${i.faces} face${i.faces === 1 ? '' : 's'}` : ''].filter(Boolean).join(', ');
      return `<div style="display:flex;align-items:center;justify-content:space-between;padding:4px 0;font-size:12px;border-bottom:1px solid #f2f1ee;">
        <span><b>${esc(label)}</b> <span class="muted">${esc(i.name)}${i.category ? ` · ${esc(i.category)}` : ''}${specs ? ` · ${esc(specs)}` : ''}</span></span>
        <span style="white-space:nowrap;">
          ${editOk ? `<button class="btn-sm" style="border:none;background:none;padding:0 4px;" onclick="App.editAssetInv('${i.id}')">Edit</button>` : ''}
          ${delOk ? `<button class="btn-sm" style="border:none;background:none;color:#c0392b;padding:0 4px;" onclick="App.removeAssetInv('${i.id}')">Delete</button>` : ''}
        </span>
      </div>`;
    }).join('') || '<div class="small muted">No Asset Inventory screens matched yet.</div>';
    return `
      <div style="margin-bottom:12px;">
        <div style="font-weight:700;font-size:13px;margin-bottom:4px;">${esc(m.name)} <span class="small muted" style="font-weight:400;">(${items.length} item${items.length === 1 ? '' : 's'}${items.length ? ` · ${screens} screen${screens === 1 ? '' : 's'} · ${faces} face${faces === 1 ? '' : 's'}` : ''})</span></div>
        <div style="max-height:220px;overflow-y:auto;">${rows}</div>
      </div>
    `;
  }).join('');

  return `
    <h3>Screens - ${esc(loc.name)}</h3>
    ${loc.is_combined ? '<div class="small muted" style="margin-bottom:8px;">Grouped by member location, matched from Asset Inventory.</div>' : ''}
    ${groups}
    <div class="modal-actions"><button type="button" class="btn-sm" onclick="App.closeModal()">Close</button></div>
  `;
});

// -------------------- combine locations --------------------
export function openCombineLocationsModal() {
  openModal('combineLocations', {});
}

export async function saveCombineLocationsForm(event) {
  event.preventDefault();
  const name = document.getElementById('cl-name').value.trim();
  const checked = Array.from(document.querySelectorAll('.cl-member:checked')).map((el) => el.value);
  if (checked.length < 2) { toast('Select at least 2 locations to combine', 'error'); return; }
  try {
    await combineLocations(name, checked);
    await logAudit('Combine locations', name);
    invalidateLocationCaches();
    closeModal();
    toast('Locations combined');
  } catch (e) { toast(e.message, 'error'); }
}

registerModal('combineLocations', () => {
  const data = pageData();
  const locations = (data?.locations || []).filter((l) => !l.is_combined).sort((a, b) => a.name.localeCompare(b.name));
  return `
    <h3>Combine Locations</h3>
    <form onsubmit="App.saveCombineLocationsForm(event)">
      <div class="field"><label>Combined Name</label><input id="cl-name" required></div>
      <div class="field"><label>Select 2 or more locations</label>
        <div style="max-height:240px;overflow-y:auto;border:1px solid var(--border);border-radius:8px;padding:8px;">
          ${locations.map((l) => `<label style="display:flex;align-items:center;gap:6px;padding:3px 0;font-weight:400;"><input type="checkbox" class="cl-member" value="${l.id}" style="width:auto;">${esc(l.name)}</label>`).join('')}
        </div>
      </div>
      <div class="modal-actions">
        <button type="button" class="btn-sm" onclick="App.closeModal()">Cancel</button>
        <button type="submit" class="btn btn-orange">Combine</button>
      </div>
    </form>
  `;
});

// -------------------- bulk add --------------------
export function openBulkAddLocationsModal() {
  openModal('bulkAddLocations', {});
}

export async function saveBulkAddLocationsForm(event) {
  event.preventDefault();
  const names = document.getElementById('bal-names').value.split('\n').map((s) => s.trim()).filter(Boolean);
  const type = document.getElementById('bal-type').value;
  const emirate = document.getElementById('bal-emirate').value;
  const chain = document.getElementById('bal-chain').value.trim();
  if (!names.length) { toast('Enter at least one location name', 'error'); return; }
  try {
    for (const name of [...new Set(names)]) {
      await saveLocation({ name, type, emirate, chain });
    }
    await logAudit('Bulk add locations', `${names.length} location(s)`);
    invalidateLocationCaches();
    closeModal();
    toast(`${names.length} location(s) added`);
  } catch (e) { toast(e.message, 'error'); }
}

registerModal('bulkAddLocations', () => `
  <h3>Bulk Add Locations</h3>
  <p class="small muted">One location name per line. Type/Emirate/Chain below apply to every line - edit individually afterward if they differ.</p>
  <form onsubmit="App.saveBulkAddLocationsForm(event)">
    <div class="field"><label>Location Names</label><textarea id="bal-names" rows="8" placeholder="Mall of the Emirates&#10;Dubai Mall&#10;City Centre Deira" required></textarea></div>
    <div class="grid2">
      <div class="field"><label>Type</label>
        <select id="bal-type">
          <option value="Planned">Planned</option>
          <option value="Installed">Installed</option>
        </select>
      </div>
      <div class="field"><label>Emirate</label>
        <select id="bal-emirate">
          <option value="">-</option>
          ${EMIRATES_ORDER.filter((e) => e !== 'Unspecified').map((e) => `<option value="${e}">${e}</option>`).join('')}
        </select>
      </div>
    </div>
    <div class="field"><label>Chain (optional)</label><input id="bal-chain"></div>
    <div class="modal-actions">
      <button type="button" class="btn-sm" onclick="App.closeModal()">Cancel</button>
      <button type="submit" class="btn btn-orange">Add All</button>
    </div>
  </form>
`);

// -------------------- unassigned assets --------------------
function unassignedAssetGroups(assetInventory, locations) {
  const locNames = new Set(locations.map((l) => l.name.toLowerCase()));
  const manuallyLinked = new Set(locations.flatMap((l) => l.manual_asset_inventory_ids || []));
  const unassigned = assetInventory.filter((r) => !manuallyLinked.has(r.id) && !locNames.has((r.venue || '').toLowerCase()));
  const groups = {};
  for (const r of unassigned) {
    const key = r.venue || '(No venue on file)';
    groups[key] = groups[key] || [];
    groups[key].push(r);
  }
  return Object.entries(groups).sort((a, b) => b[1].length - a[1].length);
}

export function openUnassignedAssetsModal() {
  openModal('unassignedAssets', {});
}

export async function assignUnassignedGroup(idx) {
  const data = pageData();
  const groups = unassignedAssetGroups(data.assetInventory, data.locations);
  const entry = groups[idx];
  if (!entry) return;
  const [, items] = entry;
  const destId = document.getElementById(`ua-dest-${idx}`).value;
  const loc = data.locations.find((l) => l.id === destId);
  if (!loc) return;
  try {
    const newIds = [...new Set([...(loc.manual_asset_inventory_ids || []), ...items.map((i) => i.id)])];
    await setManualAssetInventoryIds(destId, newIds);
    await logAudit('Assign unassigned assets', `${items.length} item(s) to ${loc.name}`);
    invalidateLocationCaches();
    closeModal();
    toast(`Assigned ${items.length} item(s) to ${loc.name}`);
  } catch (e) { toast(e.message, 'error'); }
}

registerModal('unassignedAssets', () => {
  const data = pageData();
  const groups = unassignedAssetGroups(data.assetInventory, data.locations);
  const installedLocs = data.locations.filter((l) => l.type === 'Installed' && !l.is_combined).sort((a, b) => a.name.localeCompare(b.name));
  const total = groups.reduce((s, [, items]) => s + items.length, 0);
  return `
    <h3>Unassigned Assets (${total} items)</h3>
    <p class="small muted">Asset Inventory rows whose venue text doesn't match any Location. Assign a whole venue group to the right Location.</p>
    <div style="max-height:420px;overflow-y:auto;">
      ${groups.map(([venue, items], idx) => `
        <div style="border:1px dashed var(--border);border-radius:6px;padding:8px;margin-bottom:8px;">
          <div><strong>${esc(venue)}</strong> <span class="small muted">(${items.length} items)</span></div>
          <div style="display:flex;gap:6px;margin-top:6px;">
            <select id="ua-dest-${idx}" style="flex:1;">
              ${installedLocs.map((l) => `<option value="${l.id}">${esc(l.name)}</option>`).join('')}
            </select>
            <button type="button" class="btn-sm" onclick="App.assignUnassignedGroup(${idx})">Assign All</button>
          </div>
        </div>
      `).join('') || '<div class="empty">Nothing unassigned.</div>'}
    </div>
    <div class="modal-actions"><button type="button" class="btn-sm" onclick="App.closeModal()">Close</button></div>
  `;
});

// -------------------- CRUD --------------------
export function exportLocationsCsv() {
  const locations = pageData()?.locations || [];
  exportToCsv('locations.csv', [
    { label: 'Name', value: (l) => l.name }, { label: 'Type', value: (l) => l.type },
    { label: 'Emirate', value: (l) => guessEmirate(l) }, { label: 'Address', value: (l) => l.address },
    { label: 'Chain', value: (l) => l.chain }, { label: 'Notes', value: (l) => l.notes },
  ], locations);
}

export function editLocation(id) {
  const data = pageData();
  const locations = data?.locations || [];
  const row = id ? locations.find((l) => l.id === id) : null;
  openModal('location', row ? { ...row, manualAssetInventoryIds: [...(row.manual_asset_inventory_ids || [])] } : { manualAssetInventoryIds: [] });
}

export async function removeLocation(id) {
  if (!confirm('Move this location to the Recycle Bin?')) return;
  try {
    await deleteLocation(id);
    await logAudit('Delete location', id);
    invalidateLocationCaches();
    toast('Location deleted');
    setState({});
  } catch (e) { toast(e.message, 'error'); }
}

export function addManualAssetToLocation(assetId) {
  if (!STATE.modal) return;
  const ids = new Set(STATE.modal.data.manualAssetInventoryIds || []);
  ids.add(assetId);
  STATE.modal.data.manualAssetInventoryIds = [...ids];
  setState({});
}
export function removeManualAssetFromLocation(assetId) {
  if (!STATE.modal) return;
  STATE.modal.data.manualAssetInventoryIds = (STATE.modal.data.manualAssetInventoryIds || []).filter((id) => id !== assetId);
  setState({});
}
export function searchAssetInventoryForLocationModal(query) {
  if (!STATE.modal) return;
  STATE.modal.data.__assetSearch = query;
  setState({});
}

export async function saveLocationForm(event) {
  event.preventDefault();
  const id = document.getElementById('loc-id').value || null;
  const row = {
    id,
    name: document.getElementById('loc-name').value.trim(),
    type: document.getElementById('loc-type').value,
    address: document.getElementById('loc-address').value.trim(),
    emirate: document.getElementById('loc-emirate').value,
    chain: document.getElementById('loc-chain').value.trim(),
    notes: document.getElementById('loc-notes').value.trim(),
    manualAssetInventoryIds: STATE.modal?.data?.manualAssetInventoryIds || [],
  };
  try {
    await saveLocation(row);
    await logAudit(id ? 'Edit location' : 'Add location', row.name);
    invalidateLocationCaches();
    closeModal();
    toast('Location saved');
  } catch (e) { toast(e.message, 'error'); }
}

registerModal('location', (data) => {
  const pd = pageData();
  const assetInventory = pd?.assetInventory || [];
  const linkedIds = data.manualAssetInventoryIds || [];
  const linked = assetInventory.filter((a) => linkedIds.includes(a.id));
  const query = (data.__assetSearch || '').trim().toLowerCase();
  const results = query
    ? assetInventory.filter((a) => !linkedIds.includes(a.id) && (
      (a.name || '').toLowerCase().includes(query) ||
      (a.venue || '').toLowerCase().includes(query) ||
      (a.location || '').toLowerCase().includes(query)
    )).slice(0, 20)
    : [];

  return `
    <h3>${data.id ? 'Edit' : 'Add'} Location</h3>
    <form onsubmit="App.saveLocationForm(event)">
      <input type="hidden" id="loc-id" value="${esc(data.id || '')}">
      <div class="field"><label>Name</label><input id="loc-name" value="${esc(data.name || '')}" required></div>
      <div class="grid2">
        <div class="field"><label>Type</label>
          <select id="loc-type">
            <option value="Planned" ${data.type === 'Planned' ? 'selected' : ''}>Planned</option>
            <option value="Installed" ${data.type === 'Installed' ? 'selected' : ''}>Installed</option>
          </select>
        </div>
        <div class="field"><label>Emirate</label>
          <select id="loc-emirate">
            <option value="">-</option>
            ${EMIRATES_ORDER.filter((e) => e !== 'Unspecified').map((e) => `<option value="${e}" ${data.emirate === e ? 'selected' : ''}>${e}</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="field"><label>Address</label><input id="loc-address" value="${esc(data.address || '')}"></div>
      <div class="field"><label>Chain (optional, groups related locations)</label><input id="loc-chain" value="${esc(data.chain || '')}"></div>
      <div class="field"><label>Notes</label><textarea id="loc-notes" rows="2">${esc(data.notes || '')}</textarea></div>

      ${data.id ? `
        <div class="field">
          <label>Manually Linked Asset Inventory Screens</label>
          <div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px;">
            ${linked.map((a) => `<span class="file-chip">${esc(a.venue || a.name)} - ${esc(a.location || a.name)} <button type="button" onclick="App.removeManualAssetFromLocation('${a.id}')" style="border:none;background:none;cursor:pointer;color:var(--red);">×</button></span>`).join('') || '<span class="small muted">None linked.</span>'}
          </div>
          <input id="loc-asset-link-search" placeholder="Search Asset Inventory to link..." oninput="App.searchAssetInventoryForLocationModal(this.value)" value="${esc(data.__assetSearch || '')}">
          <div style="max-height:150px;overflow-y:auto;margin-top:6px;">
            ${results.map((a) => `<div style="display:flex;justify-content:space-between;padding:4px 0;font-size:12.5px;"><span>${esc(a.venue)} - ${esc(a.location || a.name)}</span><button type="button" class="link-btn" onclick="App.addManualAssetToLocation('${a.id}')">+ Add</button></div>`).join('')}
          </div>
        </div>
      ` : '<p class="small muted">Save the location first to link Asset Inventory screens manually.</p>'}

      <div class="modal-actions">
        <button type="button" class="btn-sm" onclick="App.closeModal()">Cancel</button>
        <button type="submit" class="btn btn-orange">Save</button>
      </div>
    </form>
  `;
});
