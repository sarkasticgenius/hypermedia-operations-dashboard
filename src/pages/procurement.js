import { STATE, loadData, invalidate, openModal, closeModal, toast, setState } from '../state.js';
import { loadingCard, registerModal } from '../modals.js';
import { canAdd, canEdit, canDelete } from '../auth.js';
import { listOrders, saveOrder, deleteOrder } from '../data/orders.js';
import { listAssets } from '../data/assets.js';
import { logAudit } from '../lib/audit.js';
import { esc, fmtDate } from '../lib/format.js';

const STATUS_BADGE = { Ordered: 'b-gray', 'In Transit': 'b-amber', Delivered: 'b-green' };

export function renderProcurement() {
  const orders = loadData('orders', listOrders);
  const assets = loadData('assets', listAssets);
  if (orders === null || assets === null) return loadingCard();
  if (orders?.__error) return loadingCard(orders.__error);
  if (assets?.__error) return loadingCard(assets.__error);

  const rows = orders.map((o) => `
    <tr>
      <td>${esc(o.asset_name || '-')}</td>
      <td class="tright">${o.qty}</td>
      <td>${fmtDate(o.order_date)}</td>
      <td>${esc(o.destination || '-')}</td>
      <td><span class="badge ${STATUS_BADGE[o.status] || 'b-gray'}">${esc(o.status)}</span></td>
      <td>
        ${canEdit('orders') ? `<button class="btn-sm" onclick="App.editOrder('${o.id}')">Edit</button>` : ''}
        ${canDelete('orders') ? `<button class="btn-sm" onclick="App.removeOrder('${o.id}')">Delete</button>` : ''}
      </td>
    </tr>
  `).join('');

  return `
    <div class="toolbar">
      <div class="tabs"><div class="tab active">All Orders (${orders.length})</div></div>
      <div class="toolbar-actions">
        ${canAdd('orders') ? `<button class="btn btn-orange" onclick="App.editOrder(null)">+ New Order</button>` : ''}
      </div>
    </div>
    <div class="card">
      ${orders.length === 0 ? '<div class="empty">No orders yet.</div>' : `
        <table>
          <thead><tr><th>Asset</th><th class="tright">Qty</th><th>Order Date</th><th>Destination</th><th>Status</th><th></th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      `}
    </div>
  `;
}

export function editOrder(id) {
  const orders = STATE.pageData.orders?.data || [];
  const row = id ? orders.find((o) => o.id === id) : null;
  openModal('order', row || { order_date: new Date().toISOString().slice(0, 10) });
}

export async function removeOrder(id) {
  if (!confirm('Delete this order?')) return;
  try {
    await deleteOrder(id);
    await logAudit('Delete order', id);
    invalidate('orders');
    toast('Order deleted');
    setState({});
  } catch (e) {
    toast(e.message, 'error');
  }
}

export async function saveOrderForm(event) {
  event.preventDefault();
  const id = document.getElementById('or-id').value || null;
  const assets = STATE.pageData.assets?.data || [];
  const assetId = document.getElementById('or-asset').value || null;
  const asset = assets.find((a) => a.id === assetId);
  const row = {
    id, assetId, assetName: asset ? asset.name : null,
    qty: Number(document.getElementById('or-qty').value || 1),
    orderDate: document.getElementById('or-date').value || null,
    destination: document.getElementById('or-destination').value.trim(),
    status: document.getElementById('or-status').value,
  };
  try {
    await saveOrder(row);
    await logAudit(id ? 'Edit order' : 'Add order', row.assetName || '');
    invalidate('orders');
    closeModal();
    toast('Order saved');
  } catch (e) {
    toast(e.message, 'error');
  }
}

registerModal('order', (data) => {
  const assets = STATE.pageData.assets?.data || [];
  return `
    <h3>${data.id ? 'Edit' : 'New'} Order</h3>
    <form onsubmit="App.saveOrderForm(event)">
      <input type="hidden" id="or-id" value="${esc(data.id || '')}">
      <div class="field"><label>Asset</label>
        <select id="or-asset" required>
          <option value="">-</option>
          ${assets.map((a) => `<option value="${a.id}" ${data.asset_id === a.id ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}
        </select>
      </div>
      <div class="grid2">
        <div class="field"><label>Quantity</label><input id="or-qty" type="number" min="1" value="${data.qty || 1}"></div>
        <div class="field"><label>Order Date</label><input id="or-date" type="date" value="${data.order_date || ''}"></div>
      </div>
      <div class="field"><label>Destination</label><input id="or-destination" value="${esc(data.destination || '')}"></div>
      <div class="field"><label>Status</label>
        <select id="or-status">
          ${['Ordered', 'In Transit', 'Delivered'].map((s) => `<option value="${s}" ${(data.status || 'Ordered') === s ? 'selected' : ''}>${s}</option>`).join('')}
        </select>
      </div>
      <div class="modal-actions">
        <button type="button" class="btn-sm" onclick="App.closeModal()">Cancel</button>
        <button type="submit" class="btn btn-orange">Save</button>
      </div>
    </form>
  `;
});
