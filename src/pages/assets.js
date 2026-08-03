import { STATE, loadData, invalidate, openModal, closeModal, toast, setState } from '../state.js';
import { loadingCard, registerModal } from '../modals.js';
import { canAdd, canEdit, canDelete, canExportArea, isAdmin } from '../auth.js';
import {
  listAssets, saveAsset, deleteAsset, deployAsset, quickSetAssetStatus, markAssetFaulty, listAssetAssignments,
} from '../data/assets.js';
import { listCategories } from '../data/categories.js';
import { listLocations } from '../data/locations.js';
import { listAssetInventory } from '../data/assetsInventory.js';
import { assetInventoryForLocationFull, screenLabel } from '../data/locationStats.js';
import { logAudit } from '../lib/audit.js';
import { esc, fmtMoney, fmtDate } from '../lib/format.js';
import { exportToCsv } from '../lib/csv.js';
import { svgGroupedBarChart } from '../lib/charts.js';
import { sortTh, applySort } from '../lib/sortableTable.js';
import { renderTabs } from '../lib/tabs.js';

function isRental(categories, name) {
  return !!categories.find((c) => c.name.toLowerCase() === String(name || '').toLowerCase())?.is_rental;
}

async function loadAssetsData() {
  const [assets, categories, locations, assetInventory, assignments] = await Promise.all([
    listAssets(), listCategories(), listLocations(), listAssetInventory(), listAssetAssignments(),
  ]);
  return { assets, categories, locations, assetInventory, assignments };
}

function pageData() { return STATE.pageData.assets?.data; }

export function renderAssets() {
  const data = loadData('assets', loadAssetsData);
  if (data === null) return loadingCard();
  if (data.__error) return loadingCard(data.__error);

  const view = STATE.assetView || 'inventory';
  const deployedCount = data.assets.filter(isDeployed).length;
  const viewTabs = [
    { key: 'inventory', label: 'Inventory' },
    { key: 'deployed', label: 'Deployed', count: deployedCount || null },
    { key: 'history', label: 'Deployment History' },
  ];

  let body;
  if (view === 'history') body = renderHistoryView(data);
  else if (view === 'deployed') body = renderDeployedView(data);
  else body = renderInventoryView(data);

  return `
    <div class="toolbar">${renderTabs(viewTabs, view, 'App.setAssetView')}<div></div></div>
    ${body}
  `;
}

// An asset "counts as deployed" once any stock has actually left the warehouse - on-site stock or
// a per-location breakdown row, either one, since a unit can be on-site without (yet) having a
// breakdown row parsed from a bulk import, and vice versa.
function isDeployed(a) {
  return (a.stock_on_site || 0) > 0 || (a.asset_locations || []).length > 0;
}

export function setAssetView(v) { setState({ assetView: v }); }
export function setAssetCategoryTab(v) { setState({ assetCategoryTab: v }); }
export function setAssetStatusTab(v) { setState({ assetStatusTab: v }); }

function statusBadgeClass(status) {
  return status === 'Spare' ? 'b-green' : status === 'Deployed' ? 'b-blue' : status === 'Faulty' ? 'b-red' : 'b-gray';
}

// -------------------- inventory view --------------------
// Main/All page shows only spare stock still sitting in the warehouse - once any of a row's
// stock is deployed it moves out of here entirely and only shows on the Deployed tab, per the
// "main page shows only available spare assets" requirement.
function renderInventoryView(data) {
  const { assets, categories } = data;
  const categoryTab = STATE.assetCategoryTab || 'All';
  const statusTab = STATE.assetStatusTab || 'All';
  const spareAssets = assets.filter((a) => !isDeployed(a));
  const faultyCount = spareAssets.filter((a) => a.status === 'Faulty').length;
  const totalSpareQty = spareAssets.reduce((sum, a) => sum + (a.stock_available || 0), 0);

  const visible = spareAssets.filter((a) => {
    if (categoryTab !== 'All' && a.category !== categoryTab) return false;
    if (statusTab !== 'All' && a.status !== statusTab) return false;
    return true;
  });

  const sorted = applySort(visible, 'assetsInventoryList', {
    name: (a) => a.name || '', price: (a) => a.unit_price || 0, available: (a) => a.stock_available || 0, status: (a) => a.status || '',
  });

  const rows = sorted.map((a) => {
    const rental = isRental(categories, a.category);
    const meta = [
      a.serial_number ? `SN: ${a.serial_number}` : null,
      rental ? (a.date_of_rent ? `Rented: ${fmtDate(a.date_of_rent)}` : null) : (a.warranty_expiry ? `Warranty: ${fmtDate(a.warranty_expiry)}` : null),
      rental && a.maintenance_location ? `At: ${a.maintenance_location}` : null,
      a.maintenance_contractor ? `Contractor: ${a.maintenance_contractor}` : null,
      a.source === 'glpi' ? '<span class="badge b-blue">GLPI</span>' : null,
    ].filter(Boolean).join(' · ');
    return `
      <tr style="${a.status === 'Faulty' ? 'background:#fdecea;' : ''}">
        <td><div>${esc(a.name)}</div><div class="small muted">${esc(a.category)}${meta ? ' · ' + meta : ''}</div></td>
        <td>${fmtMoney(a.unit_price)}</td>
        <td class="tright"><strong>${a.stock_available}</strong></td>
        <td><span class="badge ${statusBadgeClass(a.status)}">${esc(a.status)}</span></td>
        <td>
          ${canEdit('assets') ? `<button class="btn-sm" onclick="App.editAsset('${a.id}')">Edit</button>` : ''}
          ${canEdit('assets') && a.stock_available > 0 ? `<button class="btn-sm" onclick="App.openDeployModal('${a.id}')">Deploy</button>` : ''}
          ${canEdit('assets') ? (a.status === 'Faulty'
            ? `<button class="btn-sm" onclick="App.quickSetStatus('${a.id}','Spare')">Mark Spare</button>`
            : `<button class="btn-sm" onclick="App.openMarkFaultyModal('${a.id}')">Mark Faulty</button>`) : ''}
          ${canDelete('assets') ? `<button class="btn-sm" onclick="App.removeAsset('${a.id}')">Delete</button>` : ''}
        </td>
      </tr>
    `;
  }).join('');

  return `
    ${faultyCount > 0 ? `<div class="banner">${faultyCount} item(s) marked Faulty - use the Faulty filter below to review, repair or retire them.</div>` : ''}
    <div class="kpi-row">
      <div class="kpi"><div class="label">Available Spare Qty</div><div class="value">${totalSpareQty}</div></div>
      <div class="kpi"><div class="label">Spare Item Rows</div><div class="value">${spareAssets.length}</div></div>
    </div>
    <div class="toolbar">
      ${renderTabs([{ key: 'All', label: 'All' }, ...categories.map((c) => ({ key: c.name, label: c.name }))], categoryTab, 'App.setAssetCategoryTab')}
    </div>
    <div class="toolbar">
      ${renderTabs(['All', 'Spare', 'Retired', 'Faulty'].map((s) => ({ key: s, label: s, count: s === 'Faulty' ? (faultyCount || null) : null })), statusTab, 'App.setAssetStatusTab')}
      <div class="toolbar-actions">
        ${canExportArea('assets') ? `<button class="btn-sm" onclick="App.exportAssetsCsv()">Export CSV</button>` : ''}
        ${isAdmin() ? `<button class="btn-sm" onclick="App.openBulkImport('assets')">Bulk Import</button>` : ''}
        ${canAdd('assets') ? `<button class="btn btn-orange" onclick="App.editAsset(null)">+ Add Asset</button>` : ''}
      </div>
    </div>
    <div class="card">
      ${visible.length === 0 ? '<div class="empty">No spare hardware assets match your filters.</div>' : `
        <table>
          <thead><tr>${sortTh('assetsInventoryList', 'name', 'Asset')}${sortTh('assetsInventoryList', 'price', 'Unit Price')}${sortTh('assetsInventoryList', 'available', 'Available (Spare)')}${sortTh('assetsInventoryList', 'status', 'Status')}<th></th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      `}
    </div>
  `;
}

// -------------------- deployed view --------------------
// Assets that have actually left the warehouse, split out from the main Inventory tab so a
// warehouse manager isn't scrolling past hundreds of shelved units to find what's live on site.
// Includes a redeployment-frequency chart (from asset_assignments history, not just the current
// snapshot) so an asset/location that keeps needing hardware swapped out is visible at a glance
// rather than only discoverable by reading the full history list one row at a time.
function redeploymentFrequency(assignments, limit = 10) {
  const counts = {};
  for (const a of assignments) {
    const key = a.asset_name || 'Unknown';
    counts[key] = (counts[key] || 0) + 1;
  }
  return Object.entries(counts)
    .filter(([, count]) => count > 1)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit);
}

function renderDeployedView(data) {
  const { assets, assignments } = data;
  const search = (STATE.assetDeployedSearch || '').trim().toLowerCase();
  const deployed = assets.filter(isDeployed).filter((a) => {
    if (!search) return true;
    const locText = (a.asset_locations || []).map((al) => al.location_name).join(' ').toLowerCase();
    return a.name.toLowerCase().includes(search) || (a.category || '').toLowerCase().includes(search) || locText.includes(search);
  });

  const repeats = redeploymentFrequency(assignments);

  const sortedDeployed = applySort(deployed, 'assetsDeployedList', {
    name: (a) => a.name || '', onSite: (a) => a.stock_on_site || 0, available: (a) => a.stock_available || 0, status: (a) => a.status || '',
  });

  const rows = sortedDeployed.map((a) => {
    const deployedLocs = (a.asset_locations || []).map((al) => `${al.location_name} (${al.qty})`).join(', ') || '-';
    return `
      <tr style="${a.status === 'Faulty' ? 'background:#fdecea;' : ''}">
        <td><div>${esc(a.name)}</div><div class="small muted">${esc(a.category)}</div></td>
        <td class="tright">${a.stock_on_site}</td>
        <td class="tright">${a.stock_available}</td>
        <td class="small">${esc(deployedLocs)}</td>
        <td><span class="badge ${statusBadgeClass(a.status)}">${esc(a.status)}</span></td>
        <td>
          ${canEdit('assets') ? `<button class="btn-sm" onclick="App.editAsset('${a.id}')">Edit</button>` : ''}
          ${canEdit('assets') && a.stock_available > 0 ? `<button class="btn-sm" onclick="App.openDeployModal('${a.id}')">Deploy More</button>` : ''}
          ${canEdit('assets') ? (a.status === 'Faulty'
            ? `<button class="btn-sm" onclick="App.quickSetStatus('${a.id}','Deployed')">Mark Deployed</button>`
            : `<button class="btn-sm" onclick="App.openMarkFaultyModal('${a.id}')">Mark Faulty</button>`) : ''}
        </td>
      </tr>
    `;
  }).join('');

  return `
    ${repeats.length ? `<div class="card">
      <div class="card-head"><h3>Most Redeployed Assets</h3><div class="desc">Asset names with more than one deployment event in history - a repeated deployment usually means the on-site unit was swapped/replaced, not just newly installed.</div></div>
      ${svgGroupedBarChart(repeats.map((r) => r[0]), [{ name: 'Deployments', color: '#e07a2c', values: repeats.map((r) => r[1]) }])}
    </div>` : ''}
    <div class="toolbar">
      <input id="asset-deployed-search" placeholder="Search deployed assets by name, category or location..." value="${esc(STATE.assetDeployedSearch || '')}" oninput="App.setAssetDeployedSearch(this.value)" style="min-width:280px;padding:7px 10px;border:1px solid var(--border);border-radius:8px;">
      <div class="toolbar-actions"><span class="small muted">${deployed.length} deployed asset row(s)</span></div>
    </div>
    <div class="card">
      ${deployed.length === 0 ? '<div class="empty">No assets have been deployed out of the warehouse yet.</div>' : `
        <table>
          <thead><tr>${sortTh('assetsDeployedList', 'name', 'Asset')}${sortTh('assetsDeployedList', 'onSite', 'On Site')}${sortTh('assetsDeployedList', 'available', 'Available (Spare)')}<th>Deployed Locations</th>${sortTh('assetsDeployedList', 'status', 'Status')}<th></th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      `}
    </div>
  `;
}

export function setAssetDeployedSearch(v) { setState({ assetDeployedSearch: v }); }

// -------------------- deployment history view --------------------
function renderHistoryView(data) {
  const { assignments } = data;
  const months = [...new Set(assignments.map((a) => (a.date || '').slice(0, 7)).filter(Boolean))].sort().reverse();
  const monthFilter = STATE.assetHistoryMonth || '';
  const visible = monthFilter ? assignments.filter((a) => (a.date || '').startsWith(monthFilter)) : assignments;

  const rows = visible.map((a) => `
    <tr>
      <td>${fmtDate(a.date)}</td>
      <td>${esc(a.asset_name || '-')}</td>
      <td>${esc(a.location_name || '-')}${a.sub_asset ? ` (${esc(a.sub_asset)})` : ''}</td>
      <td class="tright">${a.qty}</td>
      <td>${esc(a.deployed_by || '-')}</td>
    </tr>
  `).join('');

  return `
    <div class="toolbar">
      <div class="field" style="margin:0;">
        <select onchange="App.setAssetHistoryMonth(this.value)">
          <option value="">All Months</option>
          ${months.map((m) => `<option value="${m}" ${monthFilter === m ? 'selected' : ''}>${m}</option>`).join('')}
        </select>
      </div>
      <div class="toolbar-actions">
        <button class="btn-sm" onclick="App.exportAssetHistoryCsv()">Export CSV</button>
      </div>
    </div>
    <div class="card">
      ${visible.length === 0 ? '<div class="empty">No deployment history yet.</div>' : `
        <table>
          <thead><tr><th>Date</th><th>Asset</th><th>Location</th><th class="tright">Qty</th><th>Deployed By</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      `}
    </div>
  `;
}

export function setAssetHistoryMonth(v) { setState({ assetHistoryMonth: v }); }
export function exportAssetHistoryCsv() {
  const assignments = pageData()?.assignments || [];
  exportToCsv('deployment-history.csv', [
    { label: 'Date', value: (a) => a.date }, { label: 'Asset', value: (a) => a.asset_name },
    { label: 'Location', value: (a) => a.location_name }, { label: 'Qty', value: (a) => a.qty },
    { label: 'Deployed By', value: (a) => a.deployed_by },
  ], assignments);
}

// -------------------- CRUD --------------------
export function exportAssetsCsv() {
  const assets = pageData()?.assets || [];
  exportToCsv('hardware-assets.csv', [
    { label: 'Name', value: (a) => a.name }, { label: 'Category', value: (a) => a.category },
    { label: 'Unit Price', value: (a) => a.unit_price }, { label: 'Stock Available', value: (a) => a.stock_available },
    { label: 'Stock On Site', value: (a) => a.stock_on_site }, { label: 'Serial Number', value: (a) => a.serial_number },
    { label: 'Status', value: (a) => a.status }, { label: 'Notes', value: (a) => a.notes },
  ], assets);
}

// Direct DOM manipulation, not a setState() re-render - a full re-render would rebuild the whole
// form from `data` (captured once when the modal opened), discarding whatever else the admin has
// already typed into Name/Price/Serial/Notes/etc. since then. Matches the original's
// toggleAssetCategoryFields(), which does the same show/hide-in-place instead of a redraw.
export function onAssetCategoryChange(value) {
  const categories = pageData()?.categories || [];
  const rental = isRental(categories, value);
  const rentalGroup = document.getElementById('asset-rental-group');
  const warrantyGroup = document.getElementById('asset-warranty-group');
  if (rentalGroup) rentalGroup.style.display = rental ? 'grid' : 'none';
  if (warrantyGroup) warrantyGroup.style.display = rental ? 'none' : 'block';
}

export function editAsset(id) {
  const assets = pageData()?.assets || [];
  const row = id ? assets.find((a) => a.id === id) : null;
  openModal('asset', row || {});
}

export async function quickSetStatus(id, status) {
  try {
    await quickSetAssetStatus(id, status);
    await logAudit(`Mark asset ${status}`, id);
    invalidate('assets');
    toast(`Marked ${status}`);
    setState({});
  } catch (e) { toast(e.message, 'error'); }
}

// Marking Faulty asks how many units, rather than instantly flipping the whole row's stock -
// splits just that quantity out into a separate Faulty-status row for the same item.
export function openMarkFaultyModal(id) {
  const assets = pageData()?.assets || [];
  const asset = assets.find((a) => a.id === id);
  if (asset) openModal('markFaulty', { asset });
}

export async function saveMarkFaultyForm(event) {
  event.preventDefault();
  const asset = STATE.modal.data.asset;
  const bucket = document.getElementById('mf-bucket').value;
  const qty = Number(document.getElementById('mf-qty').value || 0);
  try {
    await markAssetFaulty(asset.id, bucket, qty);
    await logAudit('Mark asset faulty', `${asset.name} x${qty} (${bucket === 'onsite' ? 'on-site' : 'warehouse'})`);
    invalidate('assets');
    closeModal();
    toast(`${qty} unit(s) marked Faulty`);
  } catch (e) { toast(e.message, 'error'); }
}

registerModal('markFaulty', (data) => {
  const asset = data.asset;
  return `
    <h3>Mark Faulty - ${esc(asset.name)}</h3>
    <p class="small muted">Warehouse: ${asset.stock_available} available &middot; On Site: ${asset.stock_on_site} deployed</p>
    <form onsubmit="App.saveMarkFaultyForm(event)">
      <div class="grid2">
        <div class="field"><label>From</label>
          <select id="mf-bucket">
            <option value="available" ${asset.stock_available > 0 ? '' : 'disabled'}>Warehouse (${asset.stock_available})</option>
            <option value="onsite" ${asset.stock_on_site > 0 ? '' : 'disabled'}>On Site (${asset.stock_on_site})</option>
          </select>
        </div>
        <div class="field"><label>Quantity Faulty</label><input id="mf-qty" type="number" min="1" value="1" required></div>
      </div>
      <p class="small muted">Only this many units move to Faulty status - the rest of the stock stays as-is.</p>
      <div class="modal-actions">
        <button type="button" class="btn-sm" onclick="App.closeModal()">Cancel</button>
        <button type="submit" class="btn btn-orange">Mark Faulty</button>
      </div>
    </form>
  `;
});

export async function removeAsset(id) {
  if (!confirm('Move this asset to the Recycle Bin?')) return;
  try {
    await deleteAsset(id);
    await logAudit('Delete asset', id);
    invalidate('assets');
    toast('Asset deleted');
    setState({});
  } catch (e) {
    toast(e.message, 'error');
  }
}

export async function saveAssetForm(event) {
  event.preventDefault();
  const categories = pageData()?.categories || [];
  const id = document.getElementById('asset-id').value || null;
  const category = document.getElementById('asset-category').value;
  const rental = isRental(categories, category);
  const base = {
    name: document.getElementById('asset-name').value.trim(),
    category,
    unitPrice: Number(document.getElementById('asset-price').value || 0),
    status: document.getElementById('asset-status').value,
    notes: document.getElementById('asset-notes').value.trim(),
    maintenanceContractor: document.getElementById('asset-contractor').value.trim(),
  };
  if (rental) {
    base.dateOfRent = document.getElementById('asset-date-of-rent')?.value || null;
    base.maintenanceLocation = document.getElementById('asset-maint-location')?.value || null;
  } else {
    base.warrantyExpiry = document.getElementById('asset-warranty')?.value || null;
  }

  // Adding new (not editing): the Serial Number field is a textarea, one serial per line. Two or
  // more lines creates one row per serial number instead of a single row, since each serialized
  // unit is a distinct physical item, not a stock count - each gets 1 unit in warehouse stock.
  const serialField = document.getElementById('asset-serial');
  const serialLines = !id ? serialField.value.split('\n').map((s) => s.trim()).filter(Boolean) : [];

  try {
    if (!id && serialLines.length > 1) {
      for (const serialNumber of serialLines) {
        await saveAsset({ ...base, id: null, serialNumber, stockAvailable: 1, stockOnSite: 0 });
      }
      await logAudit('Add asset (batch)', `${base.name} x${serialLines.length}`);
      toast(`${serialLines.length} assets added`);
    } else {
      const row = {
        ...base, id,
        serialNumber: (serialLines[0] || serialField.value.trim()),
        stockAvailable: Number(document.getElementById('asset-stock-wh').value || 0),
        stockOnSite: Number(document.getElementById('asset-stock-site').value || 0),
      };
      await saveAsset(row);
      await logAudit(id ? 'Edit asset' : 'Add asset', row.name);
      toast('Asset saved');
    }
    invalidate('assets');
    closeModal();
  } catch (e) {
    toast(e.message, 'error');
  }
}

registerModal('asset', (data) => {
  const categories = pageData()?.categories || [];
  const category = data.category || categories[0]?.name || '';
  const rental = isRental(categories, category);
  return `
    <h3>${data.id ? 'Edit' : 'Add'} Hardware Asset</h3>
    <form onsubmit="App.saveAssetForm(event)">
      <input type="hidden" id="asset-id" value="${esc(data.id || '')}">
      <div class="field"><label>Name</label><input id="asset-name" value="${esc(data.name || '')}" required></div>
      <div class="grid2">
        <div class="field">
          <label>Category</label>
          <select id="asset-category" onchange="App.onAssetCategoryChange(this.value)">
            ${categories.map((c) => `<option value="${esc(c.name)}" ${c.name === category ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}
          </select>
        </div>
        <div class="field"><label>Status</label>
          <select id="asset-status">
            ${['Spare', 'Deployed', 'Retired', 'Faulty'].map((s) => `<option value="${s}" ${(data.status || 'Spare') === s ? 'selected' : ''}>${s}</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="grid2">
        <div class="field"><label>Unit Price (AED)</label><input id="asset-price" type="number" step="0.01" value="${data.unit_price || 0}"></div>
        <div class="field"><label>${data.id ? 'Serial Number' : 'Serial Number(s)'}</label>
          ${data.id
            ? `<input id="asset-serial" value="${esc(data.serial_number || '')}">`
            : `<textarea id="asset-serial" rows="2" placeholder="Optional - one per line. Enter 2 or more to create one row per serial number."></textarea>`}
        </div>
      </div>
      <div class="grid2">
        <div class="field"><label>Stock (Warehouse)</label><input id="asset-stock-wh" type="number" value="${data.stock_available || 0}"></div>
        <div class="field"><label>Stock (On Site)</label><input id="asset-stock-site" type="number" value="${data.stock_on_site || 0}"></div>
      </div>
      ${!data.id ? `<p class="small muted" style="margin:-10px 0 12px;">If you enter more than one serial number above, the Stock fields are ignored - each serial number becomes its own row with 1 unit in Warehouse stock instead.</p>` : ''}
      <div class="grid2" id="asset-rental-group" style="display:${rental ? 'grid' : 'none'};">
        <div class="field"><label>Date of Rent</label><input id="asset-date-of-rent" type="date" value="${data.date_of_rent || ''}"></div>
        <div class="field"><label>Maintenance Location</label><input id="asset-maint-location" value="${esc(data.maintenance_location || '')}"></div>
      </div>
      <div class="field" id="asset-warranty-group" style="display:${rental ? 'none' : 'block'};">
        <label>Warranty Expiry</label><input id="asset-warranty" type="date" value="${data.warranty_expiry || ''}">
      </div>
      <div class="field"><label>Maintenance Contractor</label><input id="asset-contractor" value="${esc(data.maintenance_contractor || '')}"></div>
      <div class="field"><label>Notes</label><textarea id="asset-notes" rows="2">${esc(data.notes || '')}</textarea></div>
      <div class="modal-actions">
        <button type="button" class="btn-sm" onclick="App.closeModal()">Cancel</button>
        <button type="submit" class="btn btn-orange">Save</button>
      </div>
    </form>
  `;
});

// -------------------- deploy modal --------------------
export function openDeployModal(assetId) {
  const assets = pageData()?.assets || [];
  const asset = assets.find((a) => a.id === assetId);
  if (asset) openModal('deploy', { asset });
}

// Direct DOM manipulation, not a setState() re-render - this fires on every keystroke (oninput),
// so a full re-render here would repeatedly rebuild the whole form from stale `data`, wiping out
// the Quantity field (and anything else) on every character typed into Destination.
export function onDeployDestinationChange(value) {
  const screenSel = document.getElementById('deploy-screen');
  if (!screenSel) return;
  const pd = pageData();
  const locations = pd?.locations || [];
  const assetInventory = pd?.assetInventory || [];
  const loc = value ? locations.find((l) => l.name === value) : null;
  const screens = loc ? assetInventoryForLocationFull(loc, locations, assetInventory) : [];
  screenSel.innerHTML = '<option value="">-</option>'
    + screens.map((s) => `<option value="${s.id}">${esc(screenLabel(s))}</option>`).join('');
}

export async function saveDeployForm(event) {
  event.preventDefault();
  const asset = STATE.modal.data.asset;
  const destinationName = document.getElementById('deploy-destination').value.trim();
  const subAssetId = document.getElementById('deploy-screen')?.value || '';
  const qty = Number(document.getElementById('deploy-qty').value || 0);
  if (!destinationName) { toast('Destination is required', 'error'); return; }
  const pd = pageData();
  const screen = subAssetId ? pd.assetInventory.find((a) => a.id === subAssetId) : null;
  try {
    await deployAsset({
      assetId: asset.id, assetName: asset.name, destinationName, qty,
      deployedBy: STATE.user?.name || '', subAsset: screen ? screenLabel(screen) : null,
    });
    await logAudit('Deploy asset', `${asset.name} -> ${destinationName} (${qty})`);
    invalidate('assets');
    closeModal();
    toast('Deployment confirmed');
  } catch (e) { toast(e.message, 'error'); }
}

registerModal('deploy', (data) => {
  const pd = pageData();
  const locations = pd?.locations || [];
  return `
    <h3>Deploy ${esc(data.asset.name)}</h3>
    <p class="small muted">Available in warehouse: ${data.asset.stock_available}</p>
    <form onsubmit="App.saveDeployForm(event)">
      <div class="field"><label>Destination Location</label>
        <input id="deploy-destination" list="deploy-location-list" oninput="App.onDeployDestinationChange(this.value)" required>
        <datalist id="deploy-location-list">
          ${locations.map((l) => `<option value="${esc(l.name)}">`).join('')}
        </datalist>
        <p class="small muted" style="margin-top:4px;">Typing a name that doesn't match an existing location creates a new one.</p>
      </div>
      <div class="field"><label>Sub-Asset / Screen (optional)</label>
        <select id="deploy-screen">
          <option value="">-</option>
        </select>
        <p class="small muted" style="margin-top:4px;">Populated once you type a Destination Location above.</p>
      </div>
      <div class="field"><label>Quantity to Deploy</label><input id="deploy-qty" type="number" min="1" max="${data.asset.stock_available}" value="1" required></div>
      <div class="modal-actions">
        <button type="button" class="btn-sm" onclick="App.closeModal()">Cancel</button>
        <button type="submit" class="btn btn-orange">Confirm Deployment</button>
      </div>
    </form>
  `;
});
