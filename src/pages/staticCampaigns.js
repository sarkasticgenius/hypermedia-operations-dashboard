import { STATE, loadData, invalidate, openModal, closeModal, toast, setState } from '../state.js';
import { loadingCard, registerModal } from '../modals.js';
import { canAdd, canEdit, canDelete } from '../auth.js';
import {
  listStaticCampaigns, saveStaticCampaign, deleteStaticCampaign,
  listStaticMachines, saveStaticMachine, deleteStaticMachine,
  listStaticBookings, saveStaticBooking, deleteStaticBooking, staticBookingConflict,
} from '../data/staticCampaigns.js';
import { listContractors } from '../data/contractors.js';
import { logAudit } from '../lib/audit.js';
import { esc, fmtDate, fmtMoney } from '../lib/format.js';
import { sortTh, applySort } from '../lib/sortableTable.js';

const TABS = [
  { key: 'list', label: 'Campaigns' },
  { key: 'machines', label: 'Machines' },
  { key: 'bookings', label: 'Bookings' },
];

export function renderStaticCampaigns() {
  const tab = STATE.staticTab || 'list';
  const tabsHtml = TABS.map((t) => `<div class="tab ${tab === t.key ? 'active' : ''}" onclick="App.setStaticTab('${t.key}')">${t.label}</div>`).join('');
  let body;
  if (tab === 'machines') body = renderMachinesTab();
  else if (tab === 'bookings') body = renderBookingsTab();
  else body = renderListTab();
  return `<div class="tabs">${tabsHtml}</div>${body}`;
}

export function setStaticTab(tab) {
  setState({ staticTab: tab });
}

const STATUS_BADGE = { Scheduled: 'b-blue', Live: 'b-green', Ended: 'b-gray', Paused: 'b-amber' };

function renderListTab() {
  const campaigns = loadData('staticCampaigns', listStaticCampaigns);
  if (campaigns === null) return loadingCard();
  if (campaigns?.__error) return loadingCard(campaigns.__error);

  const sorted = applySort(campaigns, 'staticCampaignsList', {
    name: (c) => c.name || '', client: (c) => c.client || '', format: (c) => c.format || '',
    dates: (c) => c.start_date || '', status: (c) => c.status || '',
  });

  const rows = sorted.map((c) => `
    <tr>
      <td>${esc(c.name)}</td>
      <td>${esc(c.client || '-')}</td>
      <td>${esc(c.format || '-')}</td>
      <td>${fmtDate(c.start_date)} - ${fmtDate(c.end_date)}</td>
      <td><span class="badge ${STATUS_BADGE[c.status] || 'b-gray'}">${esc(c.status)}</span></td>
      <td>
        ${canEdit('staticCampaigns') ? `<button class="btn-sm" onclick="App.editStaticCampaign('${c.id}')">Edit</button>` : ''}
        ${canDelete('staticCampaigns') ? `<button class="btn-sm" onclick="App.removeStaticCampaign('${c.id}')">Delete</button>` : ''}
      </td>
    </tr>
  `).join('');

  return `
    <div class="toolbar">
      <div></div>
      <div class="toolbar-actions">
        ${canAdd('staticCampaigns') ? `<button class="btn btn-orange" onclick="App.editStaticCampaign(null)">+ New Static Campaign</button>` : ''}
      </div>
    </div>
    <div class="card">
      ${campaigns.length === 0 ? '<div class="empty">No static campaigns yet.</div>' : `
        <table>
          <thead><tr>${sortTh('staticCampaignsList', 'name', 'Name')}${sortTh('staticCampaignsList', 'client', 'Client')}${sortTh('staticCampaignsList', 'format', 'Format')}${sortTh('staticCampaignsList', 'dates', 'Dates')}${sortTh('staticCampaignsList', 'status', 'Status')}<th></th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      `}
    </div>
  `;
}

function renderMachinesTab() {
  const machines = loadData('staticMachines', listStaticMachines);
  const contractors = loadData('contractors', listContractors);
  if (machines === null || contractors === null) return loadingCard();
  if (machines?.__error) return loadingCard(machines.__error);

  const sortedMachines = applySort(machines, 'staticMachinesList', {
    name: (m) => m.name || '', category: (m) => m.category || '',
    contractor: (m) => (contractors || []).find((c) => c.id === m.contractor_id)?.name || '', status: (m) => m.status || '',
  });

  const rows = sortedMachines.map((m) => {
    const contractor = (contractors || []).find((c) => c.id === m.contractor_id);
    return `
      <tr>
        <td>${esc(m.name)}</td>
        <td>${esc(m.category || '-')}</td>
        <td>${esc(contractor ? contractor.name : '-')}</td>
        <td><span class="badge ${m.status === 'Available' ? 'b-green' : m.status === 'Maintenance' ? 'b-amber' : 'b-gray'}">${esc(m.status)}</span></td>
        <td>
          ${canEdit('staticCampaigns') ? `<button class="btn-sm" onclick="App.editStaticMachine('${m.id}')">Edit</button>` : ''}
          ${canDelete('staticCampaigns') ? `<button class="btn-sm" onclick="App.removeStaticMachine('${m.id}')">Delete</button>` : ''}
        </td>
      </tr>
    `;
  }).join('');

  return `
    <div class="toolbar">
      <div></div>
      <div class="toolbar-actions">
        ${canAdd('staticCampaigns') ? `<button class="btn btn-orange" onclick="App.editStaticMachine(null)">+ Add Machine</button>` : ''}
      </div>
    </div>
    <div class="card">
      ${machines.length === 0 ? '<div class="empty">No machines yet.</div>' : `
        <table>
          <thead><tr>${sortTh('staticMachinesList', 'name', 'Name')}${sortTh('staticMachinesList', 'category', 'Category')}${sortTh('staticMachinesList', 'contractor', 'Contractor')}${sortTh('staticMachinesList', 'status', 'Status')}<th></th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      `}
    </div>
  `;
}

function renderBookingsTab() {
  const bookings = loadData('staticBookings', listStaticBookings);
  const machines = loadData('staticMachines', listStaticMachines);
  if (bookings === null || machines === null) return loadingCard();
  if (bookings?.__error) return loadingCard(bookings.__error);

  const sortedBookings = applySort(bookings, 'staticBookingsList', {
    machine: (b) => (machines || []).find((m) => m.id === b.machine_id)?.name || '',
    dates: (b) => b.start_date || '', bookedBy: (b) => b.booked_by || '',
  });

  const rows = sortedBookings.map((b) => {
    const machine = (machines || []).find((m) => m.id === b.machine_id);
    return `
      <tr>
        <td>${esc(machine ? machine.name : '-')}</td>
        <td>${fmtDate(b.start_date)} - ${fmtDate(b.end_date)}</td>
        <td>${esc(b.booked_by || '-')}</td>
        <td>
          ${canEdit('staticCampaigns') ? `<button class="btn-sm" onclick="App.editStaticBooking('${b.id}')">Edit</button>` : ''}
          ${canDelete('staticCampaigns') ? `<button class="btn-sm" onclick="App.removeStaticBooking('${b.id}')">Delete</button>` : ''}
        </td>
      </tr>
    `;
  }).join('');

  return `
    <div class="toolbar">
      <div></div>
      <div class="toolbar-actions">
        ${canAdd('staticCampaigns') ? `<button class="btn btn-orange" onclick="App.editStaticBooking(null)">+ New Booking</button>` : ''}
      </div>
    </div>
    <div class="card">
      ${bookings.length === 0 ? '<div class="empty">No bookings yet.</div>' : `
        <table>
          <thead><tr>${sortTh('staticBookingsList', 'machine', 'Machine')}${sortTh('staticBookingsList', 'dates', 'Dates')}${sortTh('staticBookingsList', 'bookedBy', 'Booked By')}<th></th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      `}
    </div>
  `;
}

// -- Static Campaign CRUD --
export function editStaticCampaign(id) {
  const campaigns = STATE.pageData.staticCampaigns?.data || [];
  const row = id ? campaigns.find((c) => c.id === id) : null;
  openModal('staticCampaign', row || {});
}

export async function removeStaticCampaign(id) {
  if (!confirm('Move this static campaign to the Recycle Bin?')) return;
  try {
    await deleteStaticCampaign(id);
    await logAudit('Delete static campaign', id);
    invalidate('staticCampaigns');
    toast('Campaign deleted');
    setState({});
  } catch (e) { toast(e.message, 'error'); }
}

export async function saveStaticCampaignForm(event) {
  event.preventDefault();
  const id = document.getElementById('sc-id').value || null;
  const row = {
    id,
    name: document.getElementById('sc-name').value.trim(),
    client: document.getElementById('sc-client').value.trim(),
    format: document.getElementById('sc-format').value,
    locations: document.getElementById('sc-locations').value.trim(),
    startDate: document.getElementById('sc-start').value || null,
    endDate: document.getElementById('sc-end').value || null,
    budget: Number(document.getElementById('sc-budget').value || 0),
    status: document.getElementById('sc-status').value,
    notes: document.getElementById('sc-notes').value.trim(),
  };
  try {
    await saveStaticCampaign(row);
    await logAudit(id ? 'Edit static campaign' : 'Add static campaign', row.name);
    invalidate('staticCampaigns');
    closeModal();
    toast('Campaign saved');
  } catch (e) { toast(e.message, 'error'); }
}

registerModal('staticCampaign', (data) => `
  <h3>${data.id ? 'Edit' : 'New'} Static Campaign</h3>
  <form onsubmit="App.saveStaticCampaignForm(event)">
    <input type="hidden" id="sc-id" value="${esc(data.id || '')}">
    <div class="field"><label>Name</label><input id="sc-name" value="${esc(data.name || '')}" required></div>
    <div class="grid2">
      <div class="field"><label>Client</label><input id="sc-client" value="${esc(data.client || '')}"></div>
      <div class="field"><label>Format</label>
        <select id="sc-format">
          ${['Billboard', 'Vinyl Wrap', 'Poster', 'Print', 'Other'].map((f) => `<option value="${f}" ${data.format === f ? 'selected' : ''}>${f}</option>`).join('')}
        </select>
      </div>
    </div>
    <div class="field"><label>Locations (comma separated)</label><input id="sc-locations" value="${esc(data.locations || '')}"></div>
    <div class="grid2">
      <div class="field"><label>Start Date</label><input id="sc-start" type="date" value="${data.start_date || ''}" required></div>
      <div class="field"><label>End Date</label><input id="sc-end" type="date" value="${data.end_date || ''}" required></div>
    </div>
    <div class="grid2">
      <div class="field"><label>Budget (AED)</label><input id="sc-budget" type="number" step="0.01" value="${data.budget || 0}"></div>
      <div class="field"><label>Status</label>
        <select id="sc-status">
          ${['Scheduled', 'Live', 'Ended', 'Paused'].map((s) => `<option value="${s}" ${(data.status || 'Scheduled') === s ? 'selected' : ''}>${s}</option>`).join('')}
        </select>
      </div>
    </div>
    <div class="field"><label>Notes</label><textarea id="sc-notes" rows="2">${esc(data.notes || '')}</textarea></div>
    <div class="modal-actions">
      <button type="button" class="btn-sm" onclick="App.closeModal()">Cancel</button>
      <button type="submit" class="btn btn-orange">Save</button>
    </div>
  </form>
`);

// -- Machines CRUD --
export function editStaticMachine(id) {
  const machines = STATE.pageData.staticMachines?.data || [];
  const row = id ? machines.find((m) => m.id === id) : null;
  openModal('staticMachine', row || {});
}

export async function removeStaticMachine(id) {
  if (!confirm('Move this machine to the Recycle Bin?')) return;
  try {
    await deleteStaticMachine(id);
    await logAudit('Delete static machine', id);
    invalidate('staticMachines');
    toast('Machine deleted');
    setState({});
  } catch (e) { toast(e.message, 'error'); }
}

export async function saveStaticMachineForm(event) {
  event.preventDefault();
  const id = document.getElementById('sm-id').value || null;
  const row = {
    id,
    name: document.getElementById('sm-name').value.trim(),
    category: document.getElementById('sm-category').value,
    contractorId: document.getElementById('sm-contractor').value || null,
    status: document.getElementById('sm-status').value,
    notes: document.getElementById('sm-notes').value.trim(),
  };
  try {
    await saveStaticMachine(row);
    await logAudit(id ? 'Edit static machine' : 'Add static machine', row.name);
    invalidate('staticMachines');
    closeModal();
    toast('Machine saved');
  } catch (e) { toast(e.message, 'error'); }
}

registerModal('staticMachine', (data) => {
  const contractors = STATE.pageData.contractors?.data || [];
  return `
    <h3>${data.id ? 'Edit' : 'Add'} Machine</h3>
    <form onsubmit="App.saveStaticMachineForm(event)">
      <input type="hidden" id="sm-id" value="${esc(data.id || '')}">
      <div class="field"><label>Name</label><input id="sm-name" value="${esc(data.name || '')}" required></div>
      <div class="grid2">
        <div class="field"><label>Category</label>
          <select id="sm-category">
            ${['Boom Lift', 'Spider Lift', 'Other'].map((c) => `<option value="${c}" ${data.category === c ? 'selected' : ''}>${c}</option>`).join('')}
          </select>
        </div>
        <div class="field"><label>Status</label>
          <select id="sm-status">
            ${['Available', 'In Use', 'Maintenance', 'Retired'].map((s) => `<option value="${s}" ${(data.status || 'Available') === s ? 'selected' : ''}>${s}</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="field"><label>Contractor</label>
        <select id="sm-contractor">
          <option value="">-</option>
          ${contractors.map((c) => `<option value="${c.id}" ${data.contractor_id === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}
        </select>
      </div>
      <div class="field"><label>Notes</label><textarea id="sm-notes" rows="2">${esc(data.notes || '')}</textarea></div>
      <div class="modal-actions">
        <button type="button" class="btn-sm" onclick="App.closeModal()">Cancel</button>
        <button type="submit" class="btn btn-orange">Save</button>
      </div>
    </form>
  `;
});

// -- Bookings CRUD --
export function editStaticBooking(id) {
  const bookings = STATE.pageData.staticBookings?.data || [];
  const row = id ? bookings.find((b) => b.id === id) : null;
  openModal('staticBooking', row || {});
}

export async function removeStaticBooking(id) {
  if (!confirm('Move this booking to the Recycle Bin?')) return;
  try {
    await deleteStaticBooking(id);
    await logAudit('Delete static booking', id);
    invalidate('staticBookings');
    toast('Booking deleted');
    setState({});
  } catch (e) { toast(e.message, 'error'); }
}

export async function saveStaticBookingForm(event) {
  event.preventDefault();
  const id = document.getElementById('sb-id').value || null;
  const machineId = document.getElementById('sb-machine').value;
  const startDate = document.getElementById('sb-start').value;
  const endDate = document.getElementById('sb-end').value;
  const bookings = STATE.pageData.staticBookings?.data || [];
  if (staticBookingConflict(bookings, machineId, startDate, endDate, id)) {
    toast('This machine is already booked for an overlapping date range', 'error');
    return;
  }
  const row = { id, machineId, startDate, endDate, bookedBy: document.getElementById('sb-booked-by').value.trim(), notes: document.getElementById('sb-notes').value.trim() };
  try {
    await saveStaticBooking(row);
    await logAudit(id ? 'Edit static booking' : 'Add static booking', machineId);
    invalidate('staticBookings');
    closeModal();
    toast('Booking saved');
  } catch (e) { toast(e.message, 'error'); }
}

registerModal('staticBooking', (data) => {
  const machines = STATE.pageData.staticMachines?.data || [];
  return `
    <h3>${data.id ? 'Edit' : 'New'} Booking</h3>
    <form onsubmit="App.saveStaticBookingForm(event)">
      <input type="hidden" id="sb-id" value="${esc(data.id || '')}">
      <div class="field"><label>Machine</label>
        <select id="sb-machine" required>
          <option value="">-</option>
          ${machines.map((m) => `<option value="${m.id}" ${data.machine_id === m.id ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}
        </select>
      </div>
      <div class="grid2">
        <div class="field"><label>Start Date</label><input id="sb-start" type="date" value="${data.start_date || ''}" required></div>
        <div class="field"><label>End Date</label><input id="sb-end" type="date" value="${data.end_date || ''}" required></div>
      </div>
      <div class="field"><label>Booked By</label><input id="sb-booked-by" value="${esc(data.booked_by || '')}"></div>
      <div class="field"><label>Notes</label><textarea id="sb-notes" rows="2">${esc(data.notes || '')}</textarea></div>
      <div class="modal-actions">
        <button type="button" class="btn-sm" onclick="App.closeModal()">Cancel</button>
        <button type="submit" class="btn btn-orange">Save</button>
      </div>
    </form>
  `;
});
