import { STATE, loadData, invalidate, openModal, closeModal, toast, setState } from '../state.js';
import { loadingCard, registerModal } from '../modals.js';
import { canAdd, canEdit, canDelete, canExportArea } from '../auth.js';
import {
  listAssetInventory, saveAssetInventory, deleteAssetInventory, quickAddNetwork, bulkPatchAssetInventory,
} from '../data/assetsInventory.js';
import { listContractors } from '../data/contractors.js';
import { listNetworks } from '../data/networks.js';
import { sortTh, applySort } from '../lib/sortableTable.js';
import { logAudit } from '../lib/audit.js';
import { esc } from '../lib/format.js';
import { exportToCsv } from '../lib/csv.js';

const PAGE_SIZE = 50;

// Every field a free-text search matches against - mirrors the original's ASSET_INV_SEARCH_FIELDS.
const SEARCH_FIELDS = ['name', 'venue', 'location', 'category', 'format', 'player_type', 'player_box_id', 'anydesk_id', 'teamviewer_id', 'sensor_id', 'source_asset_id'];

function contractorLabel(contractors, id) {
  const c = contractors.find((x) => x.id === id);
  if (!c) return '';
  return c.company && c.company !== c.name ? `${c.name} (${c.company})` : c.name;
}

async function loadAssetsInventoryData() {
  const [rows, contractors, networks] = await Promise.all([listAssetInventory(), listContractors(), listNetworks()]);
  return { rows, contractors, networks };
}

function pageData() { return STATE.pageData.assetsInventoryPage?.data; }

function matchesSearch(r, q) {
  return SEARCH_FIELDS.some((f) => String(r[f] || '').toLowerCase().includes(q))
    || (r.networkNames || []).some((n) => n.toLowerCase().includes(q));
}

function computeFiltered(rows) {
  const search = (STATE.aiSearch || '').trim().toLowerCase();
  const catFilter = STATE.aiCategory || 'All';
  const typeFilter = STATE.aiPlayerType || 'All';
  const pdoohFilter = STATE.aiPdooh || 'All';
  const hmFilter = STATE.aiManagedByHM || 'All';
  const mafFilter = !!STATE.aiMafOnly;
  return rows.filter((r) => {
    if (catFilter !== 'All' && r.category !== catFilter) return false;
    if (typeFilter !== 'All' && r.player_type !== typeFilter) return false;
    if (pdoohFilter !== 'All' && !!r.pdooh_ready !== (pdoohFilter === 'Yes')) return false;
    if (hmFilter !== 'All' && !!r.managed_by_hm !== (hmFilter === 'Yes')) return false;
    if (mafFilter && !(r.networkNames || []).some((n) => n.toUpperCase().includes('MAF'))) return false;
    if (search && !matchesSearch(r, search)) return false;
    return true;
  });
}

function sortedAndFiltered(rows, contractors) {
  const filtered = computeFiltered(rows);
  return applySort(filtered, 'assetsInventory', {
    name: (r) => r.name, venue: (r) => r.venue || '', category: (r) => r.category || '', format: (r) => r.format || '',
    player: (r) => r.player_type || '', pdooh: (r) => (r.pdooh_ready ? 1 : 0),
    contractor: (r) => contractorLabel(contractors, r.contractor_id),
  });
}

export function renderAssetsInventory() {
  const data = loadData('assetsInventoryPage', loadAssetsInventoryData);
  if (data === null) return loadingCard();
  if (data.__error) return loadingCard(data.__error);
  const { rows, contractors } = data;

  const editOk = canEdit('assetsInventory');
  const addOk = canAdd('assetsInventory');
  const delOk = canDelete('assetsInventory');
  const exportOk = canExportArea('assetsInventory');
  const bulkOk = editOk || delOk;

  const catFilter = STATE.aiCategory || 'All';
  const typeFilter = STATE.aiPlayerType || 'All';
  const pdoohFilter = STATE.aiPdooh || 'All';
  const hmFilter = STATE.aiManagedByHM || 'All';
  const categories = ['All', ...new Set(rows.map((r) => r.category).filter(Boolean))].sort((a, b) => (a === 'All' ? -1 : b === 'All' ? 1 : a.localeCompare(b)));
  const playerTypes = ['All', ...new Set(rows.map((r) => r.player_type).filter(Boolean))].sort((a, b) => (a === 'All' ? -1 : b === 'All' ? 1 : a.localeCompare(b)));

  const list = sortedAndFiltered(rows, contractors);
  const totalPages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
  const curPage = Math.min(Math.max(1, STATE.aiPage || 1), totalPages);
  const pageItems = list.slice((curPage - 1) * PAGE_SIZE, curPage * PAGE_SIZE);
  const selectedIds = new Set(STATE.aiSelectedIds || []);
  const pageIds = pageItems.map((r) => r.id);
  const allPageSelected = pageIds.length > 0 && pageIds.every((id) => selectedIds.has(id));

  const rowsHtml = pageItems.map((r) => `
    <tr>
      ${bulkOk ? `<td style="width:28px;"><input type="checkbox" ${selectedIds.has(r.id) ? 'checked' : ''} onchange="App.toggleAssetInvSelection('${r.id}', this.checked)"></td>` : ''}
      <td><b>${esc(r.name)}</b>${r.source_asset_id ? `<div class="small muted">ID: ${esc(r.source_asset_id)}</div>` : ''}</td>
      <td>${esc(r.venue || '-')}<div class="small muted">${esc(r.location || '')}</div></td>
      <td>${esc(r.category || '-')}</td>
      <td>${esc(r.format || '-')}${r.width && r.height ? `<div class="small muted">${r.width}x${r.height}</div>` : ''}</td>
      <td>${esc(r.player_type || '-')}${r.player_box_id ? `<div class="small muted">${esc(r.player_box_id)}</div>` : ''}</td>
      <td>${r.pdooh_ready ? '<span class="badge b-green">Yes</span>' : '<span class="muted small">No</span>'}</td>
      <td>${r.contractor_id ? esc(contractorLabel(contractors, r.contractor_id)) : '<span class="muted small">-</span>'}</td>
      <td>
        ${editOk ? `<button class="btn-sm" onclick="App.editAssetInv('${r.id}')">Edit</button>` : ''}
        ${delOk ? `<button class="btn-sm" onclick="App.removeAssetInv('${r.id}')">Delete</button>` : ''}
      </td>
    </tr>
  `).join('') || `<tr><td colspan="${bulkOk ? 9 : 8}"><div class="empty">No screens match this filter.</div></td></tr>`;

  const pager = totalPages > 1 ? `<div style="display:flex;align-items:center;gap:10px;justify-content:flex-end;padding:10px 4px;">
      <span class="small muted">${list.length} screen(s) - page ${curPage} of ${totalPages}</span>
      <button class="btn-sm" ${curPage <= 1 ? 'disabled' : ''} onclick="App.setAssetInvPage(${curPage - 1})">Prev</button>
      <button class="btn-sm" ${curPage >= totalPages ? 'disabled' : ''} onclick="App.setAssetInvPage(${curPage + 1})">Next</button>
    </div>` : `<div class="small muted" style="padding:10px 4px;">${list.length} screen(s)</div>`;

  return `
    <div class="banner">This is the deployed-screen/player list (one row per physical screen). Player Box ID doubles as the Broadsign client_resource_id used by the Broadsign sync. ${editOk ? '' : 'You can view this table; ask an Admin for edit permission to change it.'}</div>
    <div class="toolbar">
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;">
        <input placeholder="Search anything - name, venue, location, category, player, IDs, networks..." value="${esc(STATE.aiSearch || '')}" oninput="App.setAssetInvSearch(this.value)" style="min-width:260px;padding:7px 10px;border:1px solid var(--border);border-radius:8px;">
        <select onchange="App.setAssetInvFilter('aiCategory', this.value)" style="padding:7px 8px;border:1px solid var(--border);border-radius:8px;">${categories.map((c) => `<option value="${esc(c)}" ${catFilter === c ? 'selected' : ''}>${c === 'All' ? 'All Categories' : esc(c)}</option>`).join('')}</select>
        <select onchange="App.setAssetInvFilter('aiPlayerType', this.value)" style="padding:7px 8px;border:1px solid var(--border);border-radius:8px;">${playerTypes.map((t) => `<option value="${esc(t)}" ${typeFilter === t ? 'selected' : ''}>${t === 'All' ? 'All Player Types' : esc(t)}</option>`).join('')}</select>
        <select onchange="App.setAssetInvFilter('aiPdooh', this.value)" style="padding:7px 8px;border:1px solid var(--border);border-radius:8px;">
          <option value="All" ${pdoohFilter === 'All' ? 'selected' : ''}>pDOOH: All</option>
          <option value="Yes" ${pdoohFilter === 'Yes' ? 'selected' : ''}>pDOOH: Yes</option>
          <option value="No" ${pdoohFilter === 'No' ? 'selected' : ''}>pDOOH: No</option>
        </select>
        <select onchange="App.setAssetInvFilter('aiManagedByHM', this.value)" style="padding:7px 8px;border:1px solid var(--border);border-radius:8px;">
          <option value="All" ${hmFilter === 'All' ? 'selected' : ''}>Managed by HM: All</option>
          <option value="Yes" ${hmFilter === 'Yes' ? 'selected' : ''}>Managed by HM: Yes</option>
          <option value="No" ${hmFilter === 'No' ? 'selected' : ''}>Managed by HM: No</option>
        </select>
        <label style="display:flex;align-items:center;gap:5px;font-size:12.5px;font-weight:600;color:var(--text-dim);"><input type="checkbox" style="width:auto;" ${STATE.aiMafOnly ? 'checked' : ''} onchange="App.setAssetInvMafOnly(this.checked)"> MAF Malls only</label>
      </div>
      <div class="toolbar-actions">
        ${exportOk ? `<button class="btn-sm" onclick="App.exportAssetInvCsv(false)" title="Every row, ignoring current search/filters">Download Full CSV</button>` : ''}
        ${exportOk ? `<button class="btn-sm" onclick="App.exportAssetInvCsv(true)" title="Just the rows matching your current search/filters">Download Filtered CSV (${list.length})</button>` : ''}
        ${addOk ? `<button class="btn-sm" onclick="App.openBulkImport('assetsInventory')">Bulk Import</button>` : ''}
        ${addOk ? `<button class="btn btn-orange" onclick="App.editAssetInv(null)">+ Add Screen</button>` : ''}
      </div>
    </div>
    ${selectedIds.size > 0 ? `<div class="banner" style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;">
      <span><b>${selectedIds.size}</b> screen${selectedIds.size === 1 ? '' : 's'} selected</span>
      <div style="display:flex;gap:8px;">
        ${editOk ? `<button class="btn-sm" onclick="App.openBulkEditAssetInv()">Bulk Edit</button>` : ''}
        ${delOk ? `<button class="btn-sm" style="color:#c0392b;" onclick="App.bulkDeleteAssetInv()">Bulk Delete</button>` : ''}
        <button class="btn-sm" onclick="App.clearAssetInvSelection()">Clear Selection</button>
      </div>
    </div>` : ''}
    <div class="card" style="padding:0;">
      <table>
        <thead><tr>${bulkOk ? `<th><input type="checkbox" ${allPageSelected ? 'checked' : ''} onchange="App.toggleAssetInvSelectAllOnPage(this.checked)" title="Select all on this page"></th>` : ''}${sortTh('assetsInventory', 'name', 'Name')}${sortTh('assetsInventory', 'venue', 'Venue / Location')}${sortTh('assetsInventory', 'category', 'Category')}${sortTh('assetsInventory', 'format', 'Format')}${sortTh('assetsInventory', 'player', 'Player')}${sortTh('assetsInventory', 'pdooh', 'pDOOH')}${sortTh('assetsInventory', 'contractor', 'Contractor')}<th></th></tr></thead>
        <tbody>${rowsHtml}</tbody>
      </table>
      ${pager}
    </div>
  `;
}

export function setAssetInvSearch(value) { setState({ aiSearch: value, aiPage: 1 }); }
export function setAssetInvFilter(key, value) { setState({ [key]: value, aiPage: 1 }); }
export function setAssetInvMafOnly(checked) { setState({ aiMafOnly: checked, aiPage: 1 }); }
export function setAssetInvPage(page) { setState({ aiPage: page }); }

export function toggleAssetInvSelection(id, checked) {
  const cur = new Set(STATE.aiSelectedIds || []);
  if (checked) cur.add(id); else cur.delete(id);
  setState({ aiSelectedIds: [...cur] });
}

export function toggleAssetInvSelectAllOnPage(checked) {
  const data = pageData();
  if (!data) return;
  const list = sortedAndFiltered(data.rows, data.contractors);
  const totalPages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
  const curPage = Math.min(Math.max(1, STATE.aiPage || 1), totalPages);
  const pageIds = list.slice((curPage - 1) * PAGE_SIZE, curPage * PAGE_SIZE).map((r) => r.id);
  const cur = new Set(STATE.aiSelectedIds || []);
  if (checked) pageIds.forEach((id) => cur.add(id));
  else pageIds.forEach((id) => cur.delete(id));
  setState({ aiSelectedIds: [...cur] });
}

export function clearAssetInvSelection() { setState({ aiSelectedIds: [] }); }

export async function bulkDeleteAssetInv() {
  const ids = STATE.aiSelectedIds || [];
  if (!ids.length) return;
  if (!confirm(`Delete ${ids.length} selected screen(s) from Asset Inventory? This cannot be undone.`)) return;
  try {
    await Promise.all(ids.map((id) => deleteAssetInventory(id)));
    await logAudit('Bulk-delete asset inventory items', `${ids.length} item(s)`);
    invalidate('assetsInventoryPage');
    setState({ aiSelectedIds: [] });
    toast(`${ids.length} screen(s) deleted`);
  } catch (e) { toast(e.message, 'error'); }
}

export function openBulkEditAssetInv() { openModal('bulkEditAssetInv', {}); }

export async function saveBulkEditAssetInv(event) {
  event.preventDefault();
  const ids = STATE.aiSelectedIds || [];
  if (!ids.length) { closeModal(); return; }
  const category = document.getElementById('bai-category').value;
  const pdoohChoice = document.getElementById('bai-pdooh').value;
  const venue = document.getElementById('bai-venue').value.trim();
  const location = document.getElementById('bai-location').value.trim();
  const playerType = document.getElementById('bai-playertype').value.trim();
  const touchManagedByHM = document.getElementById('bai-managedbyhm-touch').checked;
  const managedByHMValue = document.getElementById('bai-managedbyhm').checked;
  const contractorChoice = document.getElementById('bai-contractor').value;

  const patch = {};
  if (category) patch.category = category;
  if (pdoohChoice) patch.pdooh_ready = pdoohChoice === 'yes';
  if (venue) patch.venue = venue;
  if (location) patch.location = location;
  if (playerType) patch.player_type = playerType;
  if (touchManagedByHM) patch.managed_by_hm = managedByHMValue;
  if (contractorChoice === '__clear__') patch.contractor_id = null;
  else if (contractorChoice) patch.contractor_id = contractorChoice;

  if (!Object.keys(patch).length) { toast('Set at least one field to bulk-apply, or Cancel', 'error'); return; }
  try {
    await bulkPatchAssetInventory(ids, patch);
    await logAudit('Bulk-edit asset inventory items', `${ids.length} item(s): ${Object.keys(patch).join(', ')}`);
    invalidate('assetsInventoryPage');
    closeModal();
    setState({ aiSelectedIds: [] });
    toast(`${ids.length} screen(s) updated`);
  } catch (e) { toast(e.message, 'error'); }
}

registerModal('bulkEditAssetInv', () => {
  const contractors = pageData()?.contractors || [];
  const count = (STATE.aiSelectedIds || []).length;
  return `
    <h3>Bulk Edit - ${count} Screen${count === 1 ? '' : 's'}</h3>
    <div class="small muted" style="margin-bottom:10px;">Leave a field blank ("No change") to keep each screen's existing value - only fields you actually set here get applied to all ${count} selected screen(s).</div>
    <form onsubmit="App.saveBulkEditAssetInv(event)">
      <div class="grid2">
        <div class="field"><label>Category</label>
          <select id="bai-category"><option value="">-- No change --</option>${[...new Set((pageData()?.rows || []).map((r) => r.category).filter(Boolean))].sort().map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join('')}</select>
        </div>
        <div class="field"><label>pDOOH Ready</label>
          <select id="bai-pdooh"><option value="">-- No change --</option><option value="yes">Yes</option><option value="no">No</option></select>
        </div>
      </div>
      <div class="grid2">
        <div class="field"><label>Venue</label><input id="bai-venue" placeholder="Leave blank for no change"></div>
        <div class="field"><label>Location</label><input id="bai-location" placeholder="Leave blank for no change"></div>
      </div>
      <div class="grid2">
        <div class="field"><label>Player Type</label><input id="bai-playertype" placeholder="Leave blank for no change"></div>
        <div class="field" style="align-self:flex-end;padding-bottom:8px;"><label style="display:flex;align-items:center;gap:6px;font-weight:400;"><input type="checkbox" id="bai-managedbyhm-touch" style="width:auto;" onchange="document.getElementById('bai-managedbyhm').disabled=!this.checked;"> Set Managed by HM: <input type="checkbox" id="bai-managedbyhm" style="width:auto;" disabled></label></div>
      </div>
      <div class="field"><label>Maintenance Contractor</label>
        <select id="bai-contractor">
          <option value="">-- No change --</option>
          <option value="__clear__">-- Clear contractor --</option>
          ${contractors.map((c) => `<option value="${c.id}">${esc(contractorLabel(contractors, c.id))}</option>`).join('')}
        </select>
      </div>
      <div class="modal-actions">
        <button type="button" class="btn-sm" onclick="App.closeModal()">Cancel</button>
        <button type="submit" class="btn btn-orange">Apply to ${count} Screen${count === 1 ? '' : 's'}</button>
      </div>
    </form>
  `;
});

export function exportAssetInvCsv(filteredOnly) {
  const data = pageData();
  if (!data) return;
  const rows = filteredOnly ? sortedAndFiltered(data.rows, data.contractors) : data.rows;
  exportToCsv('asset-inventory.csv', [
    { label: 'Asset ID', value: (r) => r.source_asset_id }, { label: 'Name', value: (r) => r.name },
    { label: 'Venue', value: (r) => r.venue }, { label: 'Location', value: (r) => r.location },
    { label: 'Category', value: (r) => r.category }, { label: 'Format', value: (r) => r.format },
    { label: 'Width', value: (r) => r.width }, { label: 'Height', value: (r) => r.height },
    { label: 'Screens', value: (r) => r.screens }, { label: 'Faces', value: (r) => r.faces },
    { label: 'Player Type', value: (r) => r.player_type }, { label: 'Player Box ID', value: (r) => r.player_box_id },
    { label: 'AnyDesk ID', value: (r) => r.anydesk_id }, { label: 'TeamViewer ID', value: (r) => r.teamviewer_id },
    { label: 'Sensor ID', value: (r) => r.sensor_id }, { label: 'Latitude', value: (r) => r.lat },
    { label: 'Longitude', value: (r) => r.lng }, { label: 'Multiplier', value: (r) => r.multiplier },
    { label: 'pDOOH Ready', value: (r) => r.pdooh_ready }, { label: 'Managed by HM', value: (r) => r.managed_by_hm },
    { label: 'Networks', value: (r) => (r.networkNames || []).join(', ') },
    { label: 'Contractor', value: (r) => contractorLabel(data.contractors, r.contractor_id) },
  ], rows);
}

export function editAssetInv(id) {
  const rows = pageData()?.rows || [];
  const row = id ? rows.find((r) => r.id === id) : null;
  openModal('assetInv', row || {});
}

export async function removeAssetInv(id) {
  if (!confirm('Remove this screen from Asset Inventory?')) return;
  try {
    await deleteAssetInventory(id);
    await logAudit('Delete asset inventory item', id);
    invalidate('assetsInventoryPage');
    toast('Screen deleted');
    setState({});
  } catch (e) { toast(e.message, 'error'); }
}

// Deliberately direct DOM manipulation, not a setState() re-render - a full re-render would
// rebuild the whole (long) form from `data`, discarding any other fields the admin has already
// typed into. Matches the original's quickAddNetworkInModal() for the same reason.
export async function quickAddNetworkInModal() {
  const input = document.getElementById('ai-new-network');
  const name = input.value.trim();
  if (!name) { toast('Enter a network name first', 'error'); return; }
  try {
    const net = await quickAddNetwork(name);
    invalidate('assetsInventoryPage');
    const grid = document.getElementById('ai-networks-grid');
    const existing = document.getElementById(`ai-net-${net.id}`);
    if (existing) { existing.checked = true; }
    else if (grid) {
      grid.insertAdjacentHTML('beforeend', `<label style="display:flex;align-items:center;gap:6px;font-weight:400;font-size:13px;"><input type="checkbox" id="ai-net-${net.id}" style="width:auto;" checked> ${esc(net.name)}</label>`);
    }
    input.value = '';
  } catch (e) { toast(e.message, 'error'); }
}

// Also direct DOM manipulation, same reason - just toggles the custom-player-type input's
// visibility without touching any other field's in-progress value.
export function toggleAiPlayerTypeCustom(value) {
  const el = document.getElementById('ai-playertype-custom');
  if (!el) return;
  el.style.display = value === 'Custom' ? 'block' : 'none';
  if (value !== 'Custom') el.value = '';
}

export async function saveAssetInvForm(event) {
  event.preventDefault();
  const id = document.getElementById('ai-id').value || null;
  const name = document.getElementById('ai-name').value.trim();
  if (!name) { toast('Name is required', 'error'); return; }
  const playerTypeSel = document.getElementById('ai-playertype').value;
  const playerType = playerTypeSel === 'Custom' ? document.getElementById('ai-playertype-custom').value.trim() : playerTypeSel;
  const networks = pageData()?.networks || [];
  const networkIds = networks.filter((n) => document.getElementById(`ai-net-${n.id}`)?.checked).map((n) => n.id);

  const row = {
    id, name,
    category: document.getElementById('ai-category').value.trim(),
    venue: document.getElementById('ai-venue').value.trim(),
    location: document.getElementById('ai-location').value.trim(),
    format: document.getElementById('ai-format').value.trim(),
    pdoohReady: document.getElementById('ai-pdooh').checked,
    width: Number(document.getElementById('ai-width').value) || 0,
    height: Number(document.getElementById('ai-height').value) || 0,
    screens: Number(document.getElementById('ai-screens').value) || 1,
    faces: Number(document.getElementById('ai-faces').value) || 1,
    playerType,
    playerBoxId: document.getElementById('ai-playerboxid').value.trim(),
    anydeskId: document.getElementById('ai-anydesk').value.trim(),
    teamviewerId: document.getElementById('ai-teamviewer').value.trim(),
    sensorId: document.getElementById('ai-sensorid').value.trim(),
    managedByHM: document.getElementById('ai-managedbyhm').checked,
    lat: document.getElementById('ai-lat').value.trim(),
    lng: document.getElementById('ai-lng').value.trim(),
    multiplier: document.getElementById('ai-multiplier').value.trim(),
    contractorId: document.getElementById('ai-contractor').value || null,
  };
  try {
    await saveAssetInventory(row, networkIds);
    await logAudit(id ? 'Edit asset inventory item' : 'Add asset inventory item', name);
    invalidate('assetsInventoryPage');
    closeModal();
    toast('Screen saved');
    // A brand-new screen is most useful seen in context on its venue, so route to Locations
    // instead of staying on the (very long) Asset Inventory table. Editing keeps you there.
    if (!id) setState({ page: 'locations', locationView: 'cards' });
  } catch (e) { toast(e.message, 'error'); }
}

registerModal('assetInv', (data) => {
  const pd = pageData();
  const contractors = pd?.contractors || [];
  const networks = pd?.networks || [];
  const linkedNetworkIds = new Set((data.asset_inventory_networks || []).map((n) => n.network_id));
  const playerType = data.player_type || '';
  const isCustomPlayerType = !!playerType && playerType !== 'Broadsign' && playerType !== 'Grassfish';
  return `
    <h3>${data.id ? 'Edit' : 'Add'} Screen</h3>
    <form onsubmit="App.saveAssetInvForm(event)">
      <input type="hidden" id="ai-id" value="${esc(data.id || '')}">
      <div class="grid2">
        <div class="field"><label>Name</label><input id="ai-name" value="${esc(data.name || '')}" required></div>
        <div class="field"><label>Category</label><input id="ai-category" value="${esc(data.category || '')}" placeholder="e.g. Malls, Metro, Outdoor"></div>
      </div>
      <div class="grid2">
        <div class="field"><label>Venue</label><input id="ai-venue" value="${esc(data.venue || '')}"></div>
        <div class="field"><label>Location</label><input id="ai-location" value="${esc(data.location || '')}"></div>
      </div>
      <div class="grid2">
        <div class="field"><label>Format</label><input id="ai-format" value="${esc(data.format || '')}" placeholder="PORTRAIT / LANDSCAPE"></div>
        <div class="field" style="align-self:flex-end;padding-bottom:8px;"><label style="display:flex;align-items:center;gap:6px;font-weight:400;"><input type="checkbox" id="ai-pdooh" style="width:auto;" ${data.pdooh_ready ? 'checked' : ''}> pDOOH Ready</label></div>
      </div>
      <div class="grid2">
        <div class="field"><label>Width (px)</label><input id="ai-width" type="number" value="${data.width ?? ''}"></div>
        <div class="field"><label>Height (px)</label><input id="ai-height" type="number" value="${data.height ?? ''}"></div>
      </div>
      <div class="grid2">
        <div class="field"><label>Nbr. of Screens</label><input id="ai-screens" type="number" value="${data.screens ?? 1}"></div>
        <div class="field"><label>Nbr. of Faces</label><input id="ai-faces" type="number" value="${data.faces ?? 1}"></div>
      </div>
      <div class="grid2">
        <div class="field">
          <label>Player Type</label>
          <select id="ai-playertype" onchange="App.toggleAiPlayerTypeCustom(this.value)">
            <option value="">-- Select --</option>
            <option value="Broadsign" ${playerType === 'Broadsign' ? 'selected' : ''}>Broadsign</option>
            <option value="Grassfish" ${playerType === 'Grassfish' ? 'selected' : ''}>Grassfish</option>
            <option value="Custom" ${isCustomPlayerType ? 'selected' : ''}>Custom...</option>
          </select>
          <input id="ai-playertype-custom" value="${isCustomPlayerType ? esc(playerType) : ''}" placeholder="Enter custom player type" style="margin-top:6px;display:${isCustomPlayerType ? 'block' : 'none'};">
        </div>
        <div class="field"><label>Player Box ID</label><input id="ai-playerboxid" value="${esc(data.player_box_id || '')}"></div>
      </div>
      <div class="grid2">
        <div class="field"><label>AnyDesk ID</label><input id="ai-anydesk" value="${esc(data.anydesk_id || '')}"></div>
        <div class="field"><label>TeamViewer ID</label><input id="ai-teamviewer" value="${esc(data.teamviewer_id || '')}"></div>
      </div>
      <div class="grid2">
        <div class="field"><label>Sensor ID</label><input id="ai-sensorid" value="${esc(data.sensor_id || '')}"></div>
        <div class="field" style="align-self:flex-end;padding-bottom:8px;"><label style="display:flex;align-items:center;gap:6px;font-weight:400;"><input type="checkbox" id="ai-managedbyhm" style="width:auto;" ${data.managed_by_hm ? 'checked' : ''}> Managed by HM</label></div>
      </div>
      <div class="grid2">
        <div class="field"><label>Latitude</label><input id="ai-lat" value="${esc(data.lat || '')}" placeholder="e.g. 25.1972"></div>
        <div class="field"><label>Longitude</label><input id="ai-lng" value="${esc(data.lng || '')}" placeholder="e.g. 55.2744"></div>
      </div>
      <div class="grid2">
        <div class="field" style="max-width:220px;"><label>Multiplier</label><input id="ai-multiplier" value="${esc(data.multiplier || '')}"></div>
        <div class="field">
          <label>Maintenance Contractor</label>
          <select id="ai-contractor">
            <option value="">-- No contractor assigned --</option>
            ${contractors.map((c) => `<option value="${c.id}" ${data.contractor_id === c.id ? 'selected' : ''}>${esc(contractorLabel(contractors, c.id))}</option>`).join('')}
          </select>
          <div class="small muted" style="margin-top:4px;">Manage the contractor list (and their emails) under Settings.</div>
        </div>
      </div>
      <div class="field">
        <label>Networks</label>
        <div id="ai-networks-grid" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:4px 10px;padding:8px;border:1px solid var(--border);border-radius:8px;margin-bottom:8px;">${networks.map((n) => `<label style="display:flex;align-items:center;gap:6px;font-weight:400;font-size:13px;"><input type="checkbox" id="ai-net-${n.id}" style="width:auto;" ${linkedNetworkIds.has(n.id) ? 'checked' : ''}> ${esc(n.name)}</label>`).join('') || '<span class="small muted">No networks defined yet - add one below.</span>'}</div>
        <div style="display:flex;gap:8px;">
          <input id="ai-new-network" placeholder="Add a new network...">
          <button type="button" class="btn-sm" onclick="App.quickAddNetworkInModal()">+ Add</button>
        </div>
      </div>
      <div class="modal-actions">
        ${(data.id && canDelete('assetsInventory')) ? `<button type="button" class="btn-sm" style="color:#c0392b;" onclick="App.closeModal();App.removeAssetInv('${data.id}')">Delete</button>` : ''}
        <button type="button" class="btn-sm" onclick="App.closeModal()">Cancel</button>
        <button type="submit" class="btn btn-orange">Save</button>
      </div>
    </form>
  `;
});
