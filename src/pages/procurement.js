import { STATE, loadData, invalidate, openModal, closeModal, toast, setState } from '../state.js';
import { loadingCard, registerModal } from '../modals.js';
import { canAdd, canEdit, canDelete, canExportArea } from '../auth.js';
import { listOrders, saveOrder, deleteOrder, receiveOrder, uploadOrderDeliveryNote } from '../data/orders.js';
import { listAssets, updateAssetWarrantyOrRental } from '../data/assets.js';
import { listLocations } from '../data/locations.js';
import { listCategories } from '../data/categories.js';
import { getSignedUrl } from '../lib/storage.js';
import { logAudit } from '../lib/audit.js';
import { esc, fmtDate, todayISO } from '../lib/format.js';
import { exportToCsv } from '../lib/csv.js';
import { sortTh, applySort } from '../lib/sortableTable.js';

const STATUS_BADGE = { Ordered: 'b-gray', 'In Transit': 'b-amber', Delivered: 'b-green' };

async function loadProcurementData() {
  const [orders, assets, locations, categories] = await Promise.all([listOrders(), listAssets(), listLocations(), listCategories()]);
  return { orders, assets, locations, categories };
}

function pageData() { return STATE.pageData.procurementPage?.data; }

function isRentalCategory(categories, categoryName) {
  return !!categories.find((c) => c.name.toLowerCase() === String(categoryName || '').toLowerCase())?.is_rental;
}

// Warranty (or rental) details live on the linked Hardware Asset, not the order itself - this
// looks it up for display on the main order list, same info the order form lets you edit.
function warrantyLabel(order, assets, categories) {
  const asset = assets.find((a) => a.id === order.asset_id);
  if (!asset) return '<span class="muted small">-</span>';
  if (isRentalCategory(categories, asset.category)) {
    return asset.date_of_rent
      ? `Rented ${esc(fmtDate(asset.date_of_rent))}${asset.maintenance_location ? ` · ${esc(asset.maintenance_location)}` : ''}`
      : '<span class="muted small">No rental date set</span>';
  }
  return asset.warranty_expiry ? esc(fmtDate(asset.warranty_expiry)) : '<span class="muted small">No warranty date set</span>';
}

export function renderProcurement() {
  const data = loadData('procurementPage', loadProcurementData);
  if (data === null) return loadingCard();
  if (data.__error) return loadingCard(data.__error);
  const { orders, assets, categories } = data;
  const addOk = canAdd('orders');
  const editOk = canEdit('orders');
  const delOk = canDelete('orders');
  const exportOk = canExportArea('orders');

  const sorted = applySort(orders, 'procurement', {
    asset: (o) => o.asset_name || '', qty: (o) => o.qty || 0, orderDate: (o) => o.order_date || '',
    destination: (o) => o.destination || '', status: (o) => o.status || '',
  });

  const rows = sorted.map((o) => `
    <tr>
      <td><b>${esc(o.asset_name || '-')}</b></td>
      <td class="tright">${o.qty}</td>
      <td>${fmtDate(o.order_date)}</td>
      <td>${esc(o.destination || '-')}</td>
      <td><span class="badge ${STATUS_BADGE[o.status] || 'b-gray'}">${esc(o.status)}</span></td>
      <td class="small">${warrantyLabel(o, assets, categories)}</td>
      <td>${o.delivery_note_path ? `<span class="file-chip">FILE: ${esc(o.delivery_note_filename || 'delivery-note')}</span> <a href="#" onclick="App.viewDeliveryNote('${o.delivery_note_path}');return false;" class="link-btn" style="font-size:11px;">View</a>` : '<span class="muted small">-</span>'}</td>
      <td>
        ${editOk ? `<button class="btn-sm" onclick="App.openEditOrderModal('${o.id}')">Edit</button>` : ''}
        ${o.status !== 'Delivered' && editOk ? `<button class="btn-sm" onclick="App.openReceiveModal('${o.id}')">Receive Delivery</button>` : ''}
        ${editOk ? `<button class="btn-sm" onclick="App.openUploadDeliveryNoteModal('${o.id}')">${o.delivery_note_path ? 'Replace' : 'Upload'} Delivery Note</button>` : ''}
        ${delOk ? `<button class="btn-sm" onclick="App.removeOrder('${o.id}')">Delete</button>` : ''}
      </td>
    </tr>
  `).join('');

  return `
    <div class="banner">Anyone can receive deliveries and upload delivery notes. ${addOk ? '' : 'Ask an Admin for permission to place new purchase orders.'}</div>
    <div class="toolbar">
      <div class="tabs"><div class="tab active">All Orders (${orders.length})</div></div>
      <div class="toolbar-actions">
        ${exportOk ? `<button class="btn-sm" onclick="App.exportOrdersCsv()">Export CSV</button>` : ''}
        ${addOk ? `<button class="btn btn-orange" onclick="App.openNewOrderModal()">+ New Order</button>` : ''}
      </div>
    </div>
    <div class="card">
      ${orders.length === 0 ? '<div class="empty">No purchase orders yet.</div>' : `
        <table>
          <thead><tr>${sortTh('procurement', 'asset', 'Asset')}${sortTh('procurement', 'qty', 'Qty')}${sortTh('procurement', 'orderDate', 'Order Date')}${sortTh('procurement', 'destination', 'Destination')}${sortTh('procurement', 'status', 'Status')}<th>Warranty</th><th>Delivery Note</th><th></th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      `}
    </div>
  `;
}

export function exportOrdersCsv() {
  const data = pageData();
  const orders = data?.orders || [];
  const assets = data?.assets || [];
  exportToCsv('orders.csv', [
    { label: 'Asset', value: (o) => o.asset_name }, { label: 'Qty', value: (o) => o.qty },
    { label: 'Order Date', value: (o) => o.order_date }, { label: 'Destination', value: (o) => o.destination },
    { label: 'Status', value: (o) => o.status },
    { label: 'Warranty Expiry', value: (o) => assets.find((a) => a.id === o.asset_id)?.warranty_expiry },
    { label: 'Date of Rent', value: (o) => assets.find((a) => a.id === o.asset_id)?.date_of_rent },
    { label: 'Delivery Note', value: (o) => o.delivery_note_filename },
    { label: 'Notes', value: (o) => o.notes },
  ], orders);
}

export async function viewDeliveryNote(path) {
  try {
    const url = await getSignedUrl(path, 300);
    window.open(url, '_blank');
  } catch (e) { toast(e.message, 'error'); }
}

export async function removeOrder(id) {
  if (!confirm('Move this order to the Recycle Bin?')) return;
  try {
    await deleteOrder(id);
    await logAudit('Delete order', id);
    invalidate('procurementPage');
    toast('Order deleted');
    setState({});
  } catch (e) {
    toast(e.message, 'error');
  }
}

// -------------------- New / Edit Order --------------------
// One form for both: creating sets order date to today and status to Ordered by default (both
// still editable), editing prefills everything including the linked asset's current warranty (or
// rental) details, which this form can also update - the natural point to record warranty terms
// is when the order's placed or its details are corrected, not only from Hardware Inventory.
export function openNewOrderModal() { openModal('orderForm', {}); }

export function openEditOrderModal(id) {
  const order = (pageData()?.orders || []).find((o) => o.id === id);
  if (order) openModal('orderForm', order);
}

// Direct DOM manipulation, not a setState() re-render - a full re-render would rebuild the whole
// form from `data` (captured once when the modal opened), discarding Quantity/Order Date/
// Destination if the admin already filled those in before picking (or changing) the Asset.
// Mirrors Hardware Inventory's onAssetCategoryChange for the same reason.
export function onOrderAssetChange(assetId) {
  const assets = pageData()?.assets || [];
  const categories = pageData()?.categories || [];
  const asset = assets.find((a) => a.id === assetId);
  const rental = asset ? isRentalCategory(categories, asset.category) : false;

  const hint = document.getElementById('or-asset-hint');
  const rentalGroup = document.getElementById('or-rental-group');
  const warrantyGroup = document.getElementById('or-warranty-group');
  if (hint) hint.style.display = asset ? 'none' : 'block';
  if (rentalGroup) rentalGroup.style.display = asset && rental ? 'grid' : 'none';
  if (warrantyGroup) warrantyGroup.style.display = asset && !rental ? 'block' : 'none';
  if (asset && rental) {
    document.getElementById('or-date-of-rent').value = asset.date_of_rent || '';
    document.getElementById('or-maint-location').value = asset.maintenance_location || '';
  } else if (asset) {
    document.getElementById('or-warranty').value = asset.warranty_expiry || '';
  }
}

export async function saveOrderForm(event) {
  event.preventDefault();
  const id = document.getElementById('or-id').value || null;
  const assets = pageData()?.assets || [];
  const categories = pageData()?.categories || [];
  const assetId = document.getElementById('or-asset').value;
  const qty = Number(document.getElementById('or-qty').value || 0);
  const orderDate = document.getElementById('or-date').value || todayISO();
  const destination = document.getElementById('or-dest').value.trim();
  const status = document.getElementById('or-status').value;
  const notes = document.getElementById('or-notes').value.trim();
  const asset = assets.find((a) => a.id === assetId);
  if (!asset || qty <= 0 || !destination) { toast('Please fill in all fields', 'error'); return; }

  try {
    await saveOrder({ id, assetId, assetName: asset.name, qty, orderDate, destination, status, notes });

    const rental = isRentalCategory(categories, asset.category);
    const warrantyPatch = rental
      ? { date_of_rent: document.getElementById('or-date-of-rent')?.value || null, maintenance_location: document.getElementById('or-maint-location')?.value.trim() || null }
      : { warranty_expiry: document.getElementById('or-warranty')?.value || null };
    await updateAssetWarrantyOrRental(assetId, warrantyPatch);

    await logAudit(id ? 'Edit order' : 'New order', `${asset.name} x${qty} to ${destination}`);
    invalidate('procurementPage');
    invalidate('assets');
    closeModal();
    toast(id ? 'Order updated' : 'Order placed');
  } catch (e) { toast(e.message, 'error'); }
}

registerModal('orderForm', (data) => {
  const pd = pageData();
  const assets = pd?.assets || [];
  const locations = pd?.locations || [];
  const categories = pd?.categories || [];
  const selectedAssetId = data.asset_id || '';
  const selectedAsset = assets.find((a) => a.id === selectedAssetId);
  const rental = selectedAsset ? isRentalCategory(categories, selectedAsset.category) : false;

  return `
    <h3>${data.id ? 'Edit' : 'New'} Purchase Order</h3>
    <form onsubmit="App.saveOrderForm(event)">
      <input type="hidden" id="or-id" value="${esc(data.id || '')}">
      <div class="field"><label>Asset</label>
        <select id="or-asset" onchange="App.onOrderAssetChange(this.value)" required>
          <option value="">-</option>
          ${assets.map((a) => `<option value="${a.id}" ${selectedAssetId === a.id ? 'selected' : ''}>${esc(a.name)} (${esc(a.category)})</option>`).join('')}
        </select>
      </div>
      <div class="grid2">
        <div class="field"><label>Quantity Ordered</label><input id="or-qty" type="number" min="1" value="${data.qty || 1}" required></div>
        <div class="field"><label>Order Date</label><input id="or-date" type="date" value="${data.order_date || todayISO()}"></div>
      </div>
      <div class="field"><label>Destination Location</label>
        <input id="or-dest" list="proc-loc-list" placeholder="Where this stock is headed" value="${esc(data.destination || '')}" required>
        <datalist id="proc-loc-list">${locations.map((l) => `<option value="${esc(l.name)}">`).join('')}</datalist>
      </div>
      ${data.id ? `
        <div class="field"><label>Status</label>
          <select id="or-status">
            ${['Ordered', 'In Transit', 'Delivered'].map((s) => `<option value="${s}" ${(data.status || 'Ordered') === s ? 'selected' : ''}>${s}</option>`).join('')}
          </select>
        </div>
      ` : `<input type="hidden" id="or-status" value="Ordered">`}
      <p id="or-asset-hint" class="small muted" style="display:${selectedAsset ? 'none' : 'block'};">Pick an asset to set its warranty (or rental) details here too.</p>
      <div class="grid2" id="or-rental-group" style="display:${selectedAsset && rental ? 'grid' : 'none'};">
        <div class="field"><label>Date of Rent</label><input id="or-date-of-rent" type="date" value="${selectedAsset ? (selectedAsset.date_of_rent || '') : ''}"></div>
        <div class="field"><label>Maintenance Location</label><input id="or-maint-location" value="${selectedAsset ? esc(selectedAsset.maintenance_location || '') : ''}"></div>
      </div>
      <div class="field" id="or-warranty-group" style="display:${selectedAsset && !rental ? 'block' : 'none'};">
        <label>Warranty Expiry</label><input id="or-warranty" type="date" value="${selectedAsset ? (selectedAsset.warranty_expiry || '') : ''}">
      </div>
      <div class="field"><label>Notes</label><textarea id="or-notes" rows="2" placeholder="Optional">${esc(data.notes || '')}</textarea></div>
      <div class="modal-actions">
        <button type="button" class="btn-sm" onclick="App.closeModal()">Cancel</button>
        <button type="submit" class="btn btn-orange">${data.id ? 'Save' : 'Place Order'}</button>
      </div>
    </form>
  `;
});

// -------------------- Receive Delivery --------------------
export function openReceiveModal(id) {
  const order = (pageData()?.orders || []).find((o) => o.id === id);
  if (order) openModal('receive', order);
}

export async function saveReceiveForm(event) {
  event.preventDefault();
  const id = document.getElementById('rc-id').value;
  const qtyReceived = Number(document.getElementById('rc-qty').value || 0);
  const file = document.getElementById('rc-file')?.files?.[0] || null;
  try {
    await receiveOrder(id, qtyReceived, file);
    await logAudit('Receive delivery', id);
    invalidate('procurementPage');
    invalidate('assets'); // receiving a delivery bumps the linked asset's warehouse stock
    closeModal();
    toast('Delivery received');
  } catch (e) { toast(e.message, 'error'); }
}

registerModal('receive', (data) => `
  <h3>Receive Delivery - ${esc(data.asset_name || '')}</h3>
  <div class="small muted" style="margin-bottom:10px;">Ordered qty: ${data.qty} - Destination: ${esc(data.destination || '')}</div>
  <form onsubmit="App.saveReceiveForm(event)">
    <input type="hidden" id="rc-id" value="${esc(data.id || '')}">
    <div class="field"><label>Quantity Received</label><input id="rc-qty" type="number" min="0" value="${data.qty}"></div>
    <div class="field">
      <label>Delivery Note (upload for tracking)</label>
      <div class="upload-box">
        <input type="file" id="rc-file">
      </div>
    </div>
    <div class="modal-actions">
      <button type="button" class="btn-sm" onclick="App.closeModal()">Cancel</button>
      <button type="submit" class="btn btn-orange">Mark Delivered</button>
    </div>
  </form>
`);

// -------------------- Upload / Replace Delivery Note --------------------
export function openUploadDeliveryNoteModal(id) {
  const order = (pageData()?.orders || []).find((o) => o.id === id);
  if (order) openModal('uploadDeliveryNote', order);
}

export async function saveUploadDeliveryNote(event) {
  event.preventDefault();
  const id = document.getElementById('ud-id').value;
  const file = document.getElementById('ud-file')?.files?.[0] || null;
  if (!file) { toast('Choose a file to upload first', 'error'); return; }
  try {
    await uploadOrderDeliveryNote(id, file);
    await logAudit('Upload delivery note', id);
    invalidate('procurementPage');
    closeModal();
    toast('Delivery note saved');
  } catch (e) { toast(e.message, 'error'); }
}

registerModal('uploadDeliveryNote', (data) => `
  <h3>${data.delivery_note_path ? 'Replace' : 'Upload'} Delivery Note - ${esc(data.asset_name || '')}</h3>
  <div class="small muted" style="margin-bottom:10px;">Attach a scanned/photographed copy of the delivery note. This doesn't change order status - use Receive Delivery for that.</div>
  ${data.delivery_note_path ? `<div class="small" style="margin-bottom:10px;">Current file: <b>${esc(data.delivery_note_filename || '')}</b> <a href="#" onclick="App.viewDeliveryNote('${data.delivery_note_path}');return false;" class="link-btn">View</a></div>` : ''}
  <form onsubmit="App.saveUploadDeliveryNote(event)">
    <input type="hidden" id="ud-id" value="${esc(data.id || '')}">
    <div class="field">
      <label>Delivery Note File</label>
      <div class="upload-box">
        <input type="file" id="ud-file">
      </div>
    </div>
    <div class="modal-actions">
      <button type="button" class="btn-sm" onclick="App.closeModal()">Cancel</button>
      <button type="submit" class="btn btn-orange">Save</button>
    </div>
  </form>
`);
