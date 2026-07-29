import { STATE, loadData, invalidate, openModal, closeModal, toast, setState } from '../state.js';
import { loadingCard, registerModal } from '../modals.js';
import { canAdd, canEdit, canDelete, canExportArea } from '../auth.js';
import { listLocations, saveLocation, deleteLocation } from '../data/locations.js';
import { logAudit } from '../lib/audit.js';
import { esc } from '../lib/format.js';
import { exportToCsv } from '../lib/csv.js';

const EMIRATES = ['Abu Dhabi', 'Dubai', 'Sharjah', 'Ajman', 'Fujairah', 'Ras Al Khaimah', 'Umm Al Quwain'];

export function renderLocations() {
  const locations = loadData('locations', listLocations);
  if (locations === null) return loadingCard();
  if (locations?.__error) return loadingCard(locations.__error);

  const rows = locations.map((l) => `
    <tr>
      <td>${esc(l.name)}</td>
      <td><span class="badge ${l.type === 'Installed' ? 'b-green' : 'b-gray'}">${esc(l.type)}</span></td>
      <td>${esc(l.emirate || '-')}</td>
      <td>${esc(l.chain || '-')}</td>
      <td class="tright">${(l.location_sub_assets || []).length}</td>
      <td>
        ${canEdit('locations') ? `<button class="btn-sm" onclick="App.editLocation('${l.id}')">Edit</button>` : ''}
        ${canDelete('locations') ? `<button class="btn-sm" onclick="App.removeLocation('${l.id}')">Delete</button>` : ''}
      </td>
    </tr>
  `).join('');

  return `
    <div class="toolbar">
      <div class="tabs"><div class="tab active">All Locations (${locations.length})</div></div>
      <div class="toolbar-actions">
        ${canExportArea('locations') ? `<button class="btn-sm" onclick="App.exportLocationsCsv()">Export CSV</button>` : ''}
        ${canAdd('locations') ? `<button class="btn-sm" onclick="App.openBulkImport('locations')">Bulk Import</button>` : ''}
        ${canAdd('locations') ? `<button class="btn btn-orange" onclick="App.editLocation(null)">+ Add Location</button>` : ''}
      </div>
    </div>
    <div class="card">
      ${locations.length === 0 ? '<div class="empty">No locations yet.</div>' : `
        <table>
          <thead><tr><th>Name</th><th>Type</th><th>Emirate</th><th>Chain</th><th class="tright">Sub-assets</th><th></th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      `}
    </div>
  `;
}

export function exportLocationsCsv() {
  const locations = STATE.pageData.locations?.data || [];
  exportToCsv('locations.csv', [
    { label: 'Name', value: (l) => l.name }, { label: 'Type', value: (l) => l.type },
    { label: 'Emirate', value: (l) => l.emirate }, { label: 'Address', value: (l) => l.address },
    { label: 'Chain', value: (l) => l.chain }, { label: 'Notes', value: (l) => l.notes },
  ], locations);
}

export function editLocation(id) {
  const locations = STATE.pageData.locations?.data || [];
  const row = id ? locations.find((l) => l.id === id) : null;
  openModal('location', row || {});
}

export async function removeLocation(id) {
  if (!confirm('Delete this location?')) return;
  try {
    await deleteLocation(id);
    await logAudit('Delete location', id);
    invalidate('locations');
    toast('Location deleted');
    setState({});
  } catch (e) {
    toast(e.message, 'error');
  }
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
  };
  try {
    await saveLocation(row);
    await logAudit(id ? 'Edit location' : 'Add location', row.name);
    invalidate('locations');
    closeModal();
    toast('Location saved');
  } catch (e) {
    toast(e.message, 'error');
  }
}

registerModal('location', (data) => `
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
          ${EMIRATES.map((e) => `<option value="${e}" ${data.emirate === e ? 'selected' : ''}>${e}</option>`).join('')}
        </select>
      </div>
    </div>
    <div class="field"><label>Address</label><input id="loc-address" value="${esc(data.address || '')}"></div>
    <div class="field"><label>Chain (optional, groups related locations)</label><input id="loc-chain" value="${esc(data.chain || '')}"></div>
    <div class="field"><label>Notes</label><textarea id="loc-notes" rows="2">${esc(data.notes || '')}</textarea></div>
    <div class="modal-actions">
      <button type="button" class="btn-sm" onclick="App.closeModal()">Cancel</button>
      <button type="submit" class="btn btn-orange">Save</button>
    </div>
  </form>
`);
