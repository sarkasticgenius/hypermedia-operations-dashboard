import { STATE, loadData, invalidate, openModal, closeModal, toast, setState } from '../state.js';
import { loadingCard, registerModal } from '../modals.js';
import { canAdd, canEdit, canDelete } from '../auth.js';
import { listSimCards, saveSimCard, deleteSimCard, deploySimCard } from '../data/simCards.js';
import { listLocations } from '../data/locations.js';
import { logAudit } from '../lib/audit.js';
import { esc, fmtMoney } from '../lib/format.js';

export function renderSimCards() {
  const sims = loadData('simCards', listSimCards);
  const locations = loadData('locations', listLocations);
  if (sims === null || locations === null) return loadingCard();
  if (sims?.__error) return loadingCard(sims.__error);
  if (locations?.__error) return loadingCard(locations.__error);

  const rows = sims.map((s) => `
    <tr>
      <td>${esc(s.sim_number || '-')}</td>
      <td>${esc(s.carrier || '-')}</td>
      <td>${esc(s.data_plan || '-')}</td>
      <td>${fmtMoney(s.billing_cost)}</td>
      <td><span class="badge ${s.status === 'Deployed' ? 'b-green' : 'b-gray'}">${esc(s.status)}</span></td>
      <td>${esc(s.deployed_location_name || '-')}</td>
      <td>
        ${canEdit('simCards') ? `<button class="btn-sm" onclick="App.editSimCard('${s.id}')">Edit</button>` : ''}
        ${canEdit('simCards') && s.status !== 'Deployed' ? `<button class="btn-sm" onclick="App.deploySimCardRow('${s.id}')">Deploy</button>` : ''}
        ${canDelete('simCards') ? `<button class="btn-sm" onclick="App.removeSimCard('${s.id}')">Delete</button>` : ''}
      </td>
    </tr>
  `).join('');

  return `
    <div class="toolbar">
      <div class="tabs"><div class="tab active">All SIM Cards (${sims.length})</div></div>
      <div class="toolbar-actions">
        ${canAdd('simCards') ? `<button class="btn btn-orange" onclick="App.editSimCard(null)">+ Add SIM</button>` : ''}
      </div>
    </div>
    <div class="card">
      ${sims.length === 0 ? '<div class="empty">No SIM cards yet.</div>' : `
        <table>
          <thead><tr><th>SIM Number</th><th>Carrier</th><th>Data Plan</th><th>Billing</th><th>Status</th><th>Deployed At</th><th></th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      `}
    </div>
  `;
}

export function editSimCard(id) {
  const sims = STATE.pageData.simCards?.data || [];
  const row = id ? sims.find((s) => s.id === id) : null;
  openModal('simCard', row || {});
}

export function deploySimCardRow(id) {
  const sims = STATE.pageData.simCards?.data || [];
  const row = sims.find((s) => s.id === id);
  if (row) openModal('simCardDeploy', row);
}

export async function removeSimCard(id) {
  if (!confirm('Delete this SIM card?')) return;
  try {
    await deleteSimCard(id);
    await logAudit('Delete SIM card', id);
    invalidate('simCards');
    toast('SIM card deleted');
    setState({});
  } catch (e) {
    toast(e.message, 'error');
  }
}

export async function saveSimCardForm(event) {
  event.preventDefault();
  const id = document.getElementById('sim-id').value || null;
  const row = {
    id,
    simNumber: document.getElementById('sim-number').value.trim(),
    iccid: document.getElementById('sim-iccid').value.trim(),
    carrier: document.getElementById('sim-carrier').value.trim(),
    dataPlan: document.getElementById('sim-plan').value.trim(),
    billingCost: Number(document.getElementById('sim-billing').value || 0),
    notes: document.getElementById('sim-notes').value.trim(),
    status: document.getElementById('sim-status').value,
  };
  try {
    await saveSimCard(row);
    await logAudit(id ? 'Edit SIM card' : 'Add SIM card', row.simNumber);
    invalidate('simCards');
    closeModal();
    toast('SIM card saved');
  } catch (e) {
    toast(e.message, 'error');
  }
}

export async function saveSimCardDeploy(event) {
  event.preventDefault();
  const id = document.getElementById('simd-id').value;
  const locations = STATE.pageData.locations?.data || [];
  const locationId = document.getElementById('simd-location').value || null;
  const location = locations.find((l) => l.id === locationId);
  try {
    await deploySimCard(id, { locationId, locationName: location ? location.name : null });
    await logAudit('Deploy SIM card', location ? location.name : '');
    invalidate('simCards');
    closeModal();
    toast('SIM card deployed');
  } catch (e) {
    toast(e.message, 'error');
  }
}

registerModal('simCard', (data) => `
  <h3>${data.id ? 'Edit' : 'Add'} SIM Card</h3>
  <form onsubmit="App.saveSimCardForm(event)">
    <input type="hidden" id="sim-id" value="${esc(data.id || '')}">
    <div class="grid2">
      <div class="field"><label>SIM Number</label><input id="sim-number" value="${esc(data.sim_number || '')}" required></div>
      <div class="field"><label>ICCID</label><input id="sim-iccid" value="${esc(data.iccid || '')}"></div>
    </div>
    <div class="grid2">
      <div class="field"><label>Carrier</label><input id="sim-carrier" value="${esc(data.carrier || '')}"></div>
      <div class="field"><label>Data Plan</label><input id="sim-plan" value="${esc(data.data_plan || '')}"></div>
    </div>
    <div class="grid2">
      <div class="field"><label>Billing Cost (AED/mo)</label><input id="sim-billing" type="number" step="0.01" value="${data.billing_cost || 0}"></div>
      <div class="field"><label>Status</label>
        <select id="sim-status">
          ${['In Stock', 'Deployed', 'Inactive'].map((s) => `<option value="${s}" ${(data.status || 'In Stock') === s ? 'selected' : ''}>${s}</option>`).join('')}
        </select>
      </div>
    </div>
    <div class="field"><label>Notes</label><textarea id="sim-notes" rows="2">${esc(data.notes || '')}</textarea></div>
    <div class="modal-actions">
      <button type="button" class="btn-sm" onclick="App.closeModal()">Cancel</button>
      <button type="submit" class="btn btn-orange">Save</button>
    </div>
  </form>
`);

registerModal('simCardDeploy', (data) => {
  const locations = STATE.pageData.locations?.data || [];
  return `
    <h3>Deploy SIM ${esc(data.sim_number || '')}</h3>
    <form onsubmit="App.saveSimCardDeploy(event)">
      <input type="hidden" id="simd-id" value="${esc(data.id || '')}">
      <div class="field"><label>Location</label>
        <select id="simd-location" required>
          <option value="">-</option>
          ${locations.map((l) => `<option value="${l.id}">${esc(l.name)}</option>`).join('')}
        </select>
      </div>
      <div class="modal-actions">
        <button type="button" class="btn-sm" onclick="App.closeModal()">Cancel</button>
        <button type="submit" class="btn btn-orange">Deploy</button>
      </div>
    </form>
  `;
});
