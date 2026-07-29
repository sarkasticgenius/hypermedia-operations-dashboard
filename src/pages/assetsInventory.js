import { STATE, loadData, invalidate, openModal, closeModal, toast, setState } from '../state.js';
import { loadingCard, registerModal } from '../modals.js';
import { canAdd, canEdit, canDelete } from '../auth.js';
import { listAssetInventory, saveAssetInventory, deleteAssetInventory } from '../data/assetsInventory.js';
import { listContractors } from '../data/contractors.js';
import { logAudit } from '../lib/audit.js';
import { esc } from '../lib/format.js';

function filtered(rows) {
  const q = (STATE.assetInvSearch || '').trim().toLowerCase();
  if (!q) return rows;
  return rows.filter((r) =>
    (r.name || '').toLowerCase().includes(q) ||
    (r.venue || '').toLowerCase().includes(q) ||
    (r.location || '').toLowerCase().includes(q) ||
    (r.player_box_id || '').toLowerCase().includes(q));
}

export function renderAssetsInventory() {
  const rows = loadData('assetInventory', listAssetInventory);
  const contractors = loadData('contractors', listContractors);
  if (rows === null || contractors === null) return loadingCard();
  if (rows?.__error) return loadingCard(rows.__error);
  if (contractors?.__error) return loadingCard(contractors.__error);

  const visible = filtered(rows);
  const shown = visible.slice(0, 500);

  const body = shown.map((r) => `
    <tr>
      <td>${esc(r.name)}</td>
      <td>${esc(r.venue || '-')}</td>
      <td>${esc(r.location || '-')}</td>
      <td>${esc(r.category || '-')}</td>
      <td>${esc(r.player_type || '-')}</td>
      <td>${r.pdooh_ready ? '<span class="badge b-green">Yes</span>' : '<span class="badge b-gray">No</span>'}</td>
      <td>
        ${canEdit('assetsInventory') ? `<button class="btn-sm" onclick="App.editAssetInv('${r.id}')">Edit</button>` : ''}
        ${canDelete('assetsInventory') ? `<button class="btn-sm" onclick="App.removeAssetInv('${r.id}')">Delete</button>` : ''}
      </td>
    </tr>
  `).join('');

  return `
    <div class="toolbar">
      <div class="field" style="margin:0;min-width:280px;">
        <input placeholder="Search name, venue, location, player box ID..." value="${esc(STATE.assetInvSearch || '')}" oninput="App.setAssetInvSearch(this.value)">
      </div>
      <div class="toolbar-actions">
        ${canAdd('assetsInventory') ? `<button class="btn btn-orange" onclick="App.editAssetInv(null)">+ Add Screen</button>` : ''}
      </div>
    </div>
    <div class="card">
      <div class="card-head desc">Showing ${shown.length} of ${visible.length} matching screens (${rows.length} total).</div>
      ${shown.length === 0 ? '<div class="empty">No screens found.</div>' : `
        <table>
          <thead><tr><th>Name</th><th>Venue</th><th>Location</th><th>Category</th><th>Player Type</th><th>pDOOH</th><th></th></tr></thead>
          <tbody>${body}</tbody>
        </table>
      `}
    </div>
  `;
}

export function setAssetInvSearch(value) {
  setState({ assetInvSearch: value });
}

export function editAssetInv(id) {
  const rows = STATE.pageData.assetInventory?.data || [];
  const row = id ? rows.find((r) => r.id === id) : null;
  openModal('assetInv', row || {});
}

export async function removeAssetInv(id) {
  if (!confirm('Delete this screen from Asset Inventory?')) return;
  try {
    await deleteAssetInventory(id);
    await logAudit('Delete asset inventory row', id);
    invalidate('assetInventory');
    toast('Screen deleted');
    setState({});
  } catch (e) {
    toast(e.message, 'error');
  }
}

export async function saveAssetInvForm(event) {
  event.preventDefault();
  const id = document.getElementById('ai-id').value || null;
  const row = {
    id,
    name: document.getElementById('ai-name').value.trim(),
    venue: document.getElementById('ai-venue').value.trim(),
    location: document.getElementById('ai-location').value.trim(),
    category: document.getElementById('ai-category').value.trim(),
    playerType: document.getElementById('ai-player-type').value.trim(),
    playerBoxId: document.getElementById('ai-player-box-id').value.trim(),
    pdoohReady: document.getElementById('ai-pdooh').checked,
    managedByHM: document.getElementById('ai-managed').checked,
    contractorId: document.getElementById('ai-contractor').value || null,
    format: document.getElementById('ai-format').value.trim(),
  };
  const networkNames = document.getElementById('ai-networks').value.split(',').map((s) => s.trim()).filter(Boolean);
  try {
    await saveAssetInventory(row, networkNames);
    await logAudit(id ? 'Edit asset inventory row' : 'Add asset inventory row', row.name);
    invalidate('assetInventory');
    closeModal();
    toast('Screen saved');
  } catch (e) {
    toast(e.message, 'error');
  }
}

registerModal('assetInv', (data) => {
  const contractors = STATE.pageData.contractors?.data || [];
  return `
    <h3>${data.id ? 'Edit' : 'Add'} Screen</h3>
    <form onsubmit="App.saveAssetInvForm(event)">
      <input type="hidden" id="ai-id" value="${esc(data.id || '')}">
      <div class="field"><label>Name</label><input id="ai-name" value="${esc(data.name || '')}" required></div>
      <div class="grid2">
        <div class="field"><label>Venue</label><input id="ai-venue" value="${esc(data.venue || '')}"></div>
        <div class="field"><label>Location</label><input id="ai-location" value="${esc(data.location || '')}"></div>
      </div>
      <div class="grid2">
        <div class="field"><label>Category</label><input id="ai-category" value="${esc(data.category || '')}"></div>
        <div class="field"><label>Format</label><input id="ai-format" value="${esc(data.format || '')}" placeholder="LANDSCAPE / PORTRAIT"></div>
      </div>
      <div class="grid2">
        <div class="field"><label>Player Type</label><input id="ai-player-type" value="${esc(data.player_type || '')}" placeholder="Broadsign / Grassfish"></div>
        <div class="field"><label>Player Box ID</label><input id="ai-player-box-id" value="${esc(data.player_box_id || '')}"></div>
      </div>
      <div class="field"><label>Contractor</label>
        <select id="ai-contractor">
          <option value="">-</option>
          ${contractors.map((c) => `<option value="${c.id}" ${data.contractor_id === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}
        </select>
      </div>
      <div class="field"><label>Networks (comma separated)</label><input id="ai-networks" value="${esc((data.networkNames || []).join(', '))}"></div>
      <div class="perm-grid">
        <label><input type="checkbox" id="ai-pdooh" ${data.pdooh_ready ? 'checked' : ''}> pDOOH Ready</label>
        <label><input type="checkbox" id="ai-managed" ${data.managed_by_hm ? 'checked' : ''}> Managed by HM</label>
      </div>
      <div class="modal-actions">
        <button type="button" class="btn-sm" onclick="App.closeModal()">Cancel</button>
        <button type="submit" class="btn btn-orange">Save</button>
      </div>
    </form>
  `;
});
