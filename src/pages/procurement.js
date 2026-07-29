import { STATE, loadData, invalidate, openModal, closeModal, toast, setState } from '../state.js';
import { loadingCard, registerModal } from '../modals.js';
import { canAdd, canEdit, canDelete, canExportArea } from '../auth.js';
import { listOrders, saveOrder, deleteOrder, receiveOrder, uploadOrderDeliveryNote } from '../data/orders.js';
import { listAssets } from '../data/assets.js';
import { listLocations } from '../data/locations.js';
import { getSignedUrl } from '../lib/storage.js';
import { logAudit } from '../lib/audit.js';
import { esc, fmtDate, todayISO } from '../lib/format.js';
import { exportToCsv } from '../lib/csv.js';

const STATUS_BADGE = { Ordered: 'b-gray', 'In Transit': 'b-amber', Delivered: 'b-green' };

async function loadProcurementData() {
  const [orders, assets, locations] = await Promise.all([listOrders(), listAssets(), listLocations()]);
  return { orders, assets, locations };
}

function pageData() { return STATE.pageData.procurementPage?.data; }

export function renderProcurement() {
  const data = loadData('procurementPage', loadProcurementData);
  if (data === null) return loadingCard();
  if (data.__error) return loadingCard(data.__error);
  const { orders } = data;
  const addOk = canAdd('orders');
  const editOk = canEdit('orders');
  const delOk = canDelete('orders');
  const exportOk = canExportArea('orders');

  const rows = orders.map((o) => `
    <tr>
      <td><b>${esc(o.asset_name || '-')}</b></td>
      <td class="tright">${o.qty}</td>
      <td>${fmtDate(o.order_date)}</td>
      <td>${esc(o.destination || '-')}</td>
      <td><span class="badge ${STATUS_BADGE[o.status] || 'b-gray'}">${esc(o.status)}</span></td>
      <td>${o.delivery_note_path ? `<span class="file-chip">FILE: ${esc(o.delivery_note_filename || 'delivery-note')}</span> <a href="#" onclick="App.viewDeliveryNote('${o.delivery_note_path}');return false;" class="link-btn" style="font-size:11px;">View</a>` : '<span class="muted small">-</span>'}</td>
      <td>
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
          <thead><tr><th>Asset</th><th class="tright">Qty</th><th>Order Date</th><th>Destination</th><th>Status</th><th>Delivery Note</th><th></th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      `}
    </div>
  `;
}

export function exportOrdersCsv() {
  const orders = pageData()?.orders || [];
  exportToCsv('orders.csv', [
    { label: 'Asset', value: (o) => o.asset_name }, { label: 'Qty', value: (o) => o.qty },
    { label: 'Order Date', value: (o) => o.order_date }, { label: 'Destination', value: (o) => o.destination },
    { label: 'Status', value: (o) => o.status }, { label: 'Delivery Note', value: (o) => o.delivery_note_filename },
  ], orders);
}

export async function viewDeliveryNote(path) {
  try {
    const url = await getSignedUrl(path, 300);
    window.open(url, '_blank');
  } catch (e) { toast(e.message, 'error'); }
}

export async function removeOrder(id) {
  if (!confirm('Delete this order?')) return;
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

// -------------------- New Order --------------------
export function openNewOrderModal() { openModal('newOrder', {}); }

export async function saveNewOrder(event) {
  event.preventDefault();
  const assets = pageData()?.assets || [];
  const assetId = document.getElementById('no-asset').value;
  const qty = Number(document.getElementById('no-qty').value || 0);
  const destination = document.getElementById('no-dest').value.trim();
  const asset = assets.find((a) => a.id === assetId);
  if (!asset || qty <= 0 || !destination) { toast('Please fill in all fields', 'error'); return; }
  try {
    await saveOrder({ assetId, assetName: asset.name, qty, destination, orderDate: todayISO(), status: 'Ordered' });
    await logAudit('New order', `${asset.name} x${qty} to ${destination}`);
    invalidate('procurementPage');
    closeModal();
    toast('Order placed');
  } catch (e) { toast(e.message, 'error'); }
}

registerModal('newOrder', () => {
  const data = pageData();
  const assets = data?.assets || [];
  const locations = data?.locations || [];
  return `
    <h3>New Purchase Order</h3>
    <form onsubmit="App.saveNewOrder(event)">
      <div class="field"><label>Asset</label>
        <select id="no-asset" required>
          <option value="">-</option>
          ${assets.map((a) => `<option value="${a.id}">${esc(a.name)} (${esc(a.category)})</option>`).join('')}
        </select>
      </div>
      <div class="field"><label>Quantity Ordered</label><input id="no-qty" type="number" min="1" required></div>
      <div class="field"><label>Destination Location</label>
        <input id="no-dest" list="proc-loc-list" placeholder="Where this stock is headed" required>
        <datalist id="proc-loc-list">${locations.map((l) => `<option value="${esc(l.name)}">`).join('')}</datalist>
      </div>
      <div class="modal-actions">
        <button type="button" class="btn-sm" onclick="App.closeModal()">Cancel</button>
        <button type="submit" class="btn btn-orange">Place Order</button>
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
