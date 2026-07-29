import { STATE, loadData, invalidate, openModal, closeModal, toast, setState } from '../state.js';
import { loadingCard } from '../modals.js';
import { registerModal } from '../modals.js';
import { canAdd, canEdit, canDelete, canExportArea } from '../auth.js';
import { listAssets, saveAsset, deleteAsset } from '../data/assets.js';
import { listCategories } from '../data/categories.js';
import { logAudit } from '../lib/audit.js';
import { esc, fmtMoney, fmtDate } from '../lib/format.js';
import { exportToCsv } from '../lib/csv.js';
import { openBulkImport } from './bulkImport.js';

function isRental(categories, name) {
  return !!categories.find((c) => c.name.toLowerCase() === String(name || '').toLowerCase())?.is_rental;
}

export function renderAssets() {
  const assets = loadData('assets', listAssets);
  const categories = loadData('categories', listCategories);
  if (assets === null || categories === null) return loadingCard();
  if (assets?.__error) return loadingCard(assets.__error);
  if (categories?.__error) return loadingCard(categories.__error);

  const rows = assets.map((a) => `
    <tr>
      <td>${esc(a.name)}</td>
      <td>${esc(a.category)}</td>
      <td>${fmtMoney(a.unit_price)}</td>
      <td class="tright">${a.stock_available}</td>
      <td class="tright">${a.stock_on_site}</td>
      <td><span class="badge ${a.status === 'Active' ? 'b-green' : a.status === 'Faulty' ? 'b-red' : 'b-gray'}">${esc(a.status)}</span></td>
      <td>
        ${canEdit('assets') ? `<button class="btn-sm" onclick="App.editAsset('${a.id}')">Edit</button>` : ''}
        ${canDelete('assets') ? `<button class="btn-sm" onclick="App.removeAsset('${a.id}')">Delete</button>` : ''}
      </td>
    </tr>
  `).join('');

  return `
    <div class="toolbar">
      <div class="tabs"><div class="tab active">All Hardware (${assets.length})</div></div>
      <div class="toolbar-actions">
        ${canExportArea('assets') ? `<button class="btn-sm" onclick="App.exportAssetsCsv()">Export CSV</button>` : ''}
        ${canAdd('assets') ? `<button class="btn-sm" onclick="App.openBulkImport('assets')">Bulk Import</button>` : ''}
        ${canAdd('assets') ? `<button class="btn btn-orange" onclick="App.editAsset(null)">+ Add Asset</button>` : ''}
      </div>
    </div>
    <div class="card">
      ${assets.length === 0 ? '<div class="empty">No hardware assets yet.</div>' : `
        <table>
          <thead><tr><th>Name</th><th>Category</th><th>Unit Price</th><th class="tright">Stock (WH)</th><th class="tright">Stock (Site)</th><th>Status</th><th></th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      `}
    </div>
  `;
}

export function exportAssetsCsv() {
  const assets = STATE.pageData.assets?.data || [];
  exportToCsv('hardware-assets.csv', [
    { label: 'Name', value: (a) => a.name }, { label: 'Category', value: (a) => a.category },
    { label: 'Unit Price', value: (a) => a.unit_price }, { label: 'Stock Available', value: (a) => a.stock_available },
    { label: 'Stock On Site', value: (a) => a.stock_on_site }, { label: 'Serial Number', value: (a) => a.serial_number },
    { label: 'Status', value: (a) => a.status }, { label: 'Notes', value: (a) => a.notes },
  ], assets);
}

export function onAssetCategoryChange(value) {
  if (STATE.modal) {
    STATE.modal.data = { ...STATE.modal.data, category: value };
    setState({});
  }
}

export function editAsset(id) {
  const assets = STATE.pageData.assets?.data || [];
  const row = id ? assets.find((a) => a.id === id) : null;
  openModal('asset', row || {});
}

export async function removeAsset(id) {
  if (!confirm('Delete this asset?')) return;
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
  const categories = STATE.pageData.categories?.data || [];
  const id = document.getElementById('asset-id').value || null;
  const category = document.getElementById('asset-category').value;
  const rental = isRental(categories, category);
  const row = {
    id,
    name: document.getElementById('asset-name').value.trim(),
    category,
    unitPrice: Number(document.getElementById('asset-price').value || 0),
    stockAvailable: Number(document.getElementById('asset-stock-wh').value || 0),
    stockOnSite: Number(document.getElementById('asset-stock-site').value || 0),
    serialNumber: document.getElementById('asset-serial').value.trim(),
    status: document.getElementById('asset-status').value,
    notes: document.getElementById('asset-notes').value.trim(),
    maintenanceContractor: document.getElementById('asset-contractor').value.trim(),
  };
  if (rental) {
    row.dateOfRent = document.getElementById('asset-date-of-rent')?.value || null;
    row.maintenanceLocation = document.getElementById('asset-maint-location')?.value || null;
  } else {
    row.warrantyExpiry = document.getElementById('asset-warranty')?.value || null;
  }
  try {
    await saveAsset(row);
    await logAudit(id ? 'Edit asset' : 'Add asset', row.name);
    invalidate('assets');
    closeModal();
    toast('Asset saved');
  } catch (e) {
    toast(e.message, 'error');
  }
}

registerModal('asset', (data) => {
  const categories = STATE.pageData.categories?.data || [];
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
            ${['Active', 'Retired', 'Faulty'].map((s) => `<option value="${s}" ${data.status === s ? 'selected' : ''}>${s}</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="grid2">
        <div class="field"><label>Unit Price (AED)</label><input id="asset-price" type="number" step="0.01" value="${data.unit_price || 0}"></div>
        <div class="field"><label>Serial Number</label><input id="asset-serial" value="${esc(data.serial_number || '')}"></div>
      </div>
      <div class="grid2">
        <div class="field"><label>Stock (Warehouse)</label><input id="asset-stock-wh" type="number" value="${data.stock_available || 0}"></div>
        <div class="field"><label>Stock (On Site)</label><input id="asset-stock-site" type="number" value="${data.stock_on_site || 0}"></div>
      </div>
      ${rental ? `
        <div class="grid2">
          <div class="field"><label>Date of Rent</label><input id="asset-date-of-rent" type="date" value="${data.date_of_rent || ''}"></div>
          <div class="field"><label>Maintenance Location</label><input id="asset-maint-location" value="${esc(data.maintenance_location || '')}"></div>
        </div>
      ` : `
        <div class="field"><label>Warranty Expiry</label><input id="asset-warranty" type="date" value="${data.warranty_expiry || ''}"></div>
      `}
      <div class="field"><label>Maintenance Contractor</label><input id="asset-contractor" value="${esc(data.maintenance_contractor || '')}"></div>
      <div class="field"><label>Notes</label><textarea id="asset-notes" rows="2">${esc(data.notes || '')}</textarea></div>
      <div class="modal-actions">
        <button type="button" class="btn-sm" onclick="App.closeModal()">Cancel</button>
        <button type="submit" class="btn btn-orange">Save</button>
      </div>
    </form>
  `;
});
