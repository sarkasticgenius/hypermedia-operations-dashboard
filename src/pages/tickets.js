import { STATE, loadData, invalidate, openModal, closeModal, toast, setState } from '../state.js';
import { loadingCard, registerModal } from '../modals.js';
import { canAdd, canEdit, canDelete } from '../auth.js';
import { listTickets, saveTicket, deleteTicket } from '../data/tickets.js';
import { logAudit } from '../lib/audit.js';
import { esc, fmtDate } from '../lib/format.js';

const STATUS_BADGE = { Open: 'b-red', 'In Progress': 'b-amber', Resolved: 'b-blue', Closed: 'b-gray' };

export function renderTickets() {
  const tickets = loadData('tickets', listTickets);
  if (tickets === null) return loadingCard();
  if (tickets?.__error) return loadingCard(tickets.__error);

  const rows = tickets.map((t) => `
    <tr>
      <td>${esc(t.title)}</td>
      <td>${esc(t.location || '-')}</td>
      <td><span class="badge ${STATUS_BADGE[t.status] || 'b-gray'}">${esc(t.status)}</span></td>
      <td>${esc(t.priority)}</td>
      <td>${fmtDate(t.date_reported)}</td>
      <td>
        ${canEdit('tickets') ? `<button class="btn-sm" onclick="App.editTicket('${t.id}')">Edit</button>` : ''}
        ${canDelete('tickets') ? `<button class="btn-sm" onclick="App.removeTicket('${t.id}')">Delete</button>` : ''}
      </td>
    </tr>
  `).join('');

  return `
    <div class="toolbar">
      <div class="tabs"><div class="tab active">All Tickets (${tickets.length})</div></div>
      <div class="toolbar-actions">
        ${canAdd('tickets') ? `<button class="btn btn-orange" onclick="App.editTicket(null)">+ New Ticket</button>` : ''}
      </div>
    </div>
    <div class="card">
      ${tickets.length === 0 ? '<div class="empty">No tickets yet.</div>' : `
        <table>
          <thead><tr><th>Title</th><th>Location</th><th>Status</th><th>Priority</th><th>Reported</th><th></th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      `}
    </div>
  `;
}

export function editTicket(id) {
  const tickets = STATE.pageData.tickets?.data || [];
  const row = id ? tickets.find((t) => t.id === id) : null;
  openModal('ticket', row || { date_reported: new Date().toISOString().slice(0, 10) });
}

export async function removeTicket(id) {
  if (!confirm('Delete this ticket?')) return;
  try {
    await deleteTicket(id);
    await logAudit('Delete ticket', id);
    invalidate('tickets');
    toast('Ticket deleted');
    setState({});
  } catch (e) {
    toast(e.message, 'error');
  }
}

export async function saveTicketForm(event) {
  event.preventDefault();
  const id = document.getElementById('tk-id').value || null;
  const status = document.getElementById('tk-status').value;
  const rootCause = document.getElementById('tk-root-cause').value.trim();
  if (status === 'Closed' && !rootCause) {
    toast('Root cause is required before closing a ticket', 'error');
    return;
  }
  const row = {
    id,
    type: document.getElementById('tk-type').value,
    title: document.getElementById('tk-title').value.trim(),
    location: document.getElementById('tk-location').value.trim(),
    description: document.getElementById('tk-description').value.trim(),
    status,
    priority: document.getElementById('tk-priority').value,
    rootCause,
    reportedBy: document.getElementById('tk-reported-by').value.trim(),
    dateReported: document.getElementById('tk-date-reported').value || null,
    dateClosed: status === 'Closed' ? new Date().toISOString().slice(0, 10) : null,
  };
  try {
    await saveTicket(row);
    await logAudit(id ? 'Edit ticket' : 'Add ticket', row.title);
    invalidate('tickets');
    closeModal();
    toast('Ticket saved');
  } catch (e) {
    toast(e.message, 'error');
  }
}

registerModal('ticket', (data) => `
  <h3>${data.id ? 'Edit' : 'New'} Ticket</h3>
  <form onsubmit="App.saveTicketForm(event)">
    <input type="hidden" id="tk-id" value="${esc(data.id || '')}">
    <div class="field"><label>Title</label><input id="tk-title" value="${esc(data.title || '')}" required></div>
    <div class="grid2">
      <div class="field"><label>Type</label>
        <select id="tk-type">
          <option value="Issue" ${data.type === 'Issue' ? 'selected' : ''}>Issue</option>
          <option value="Internal" ${data.type === 'Internal' ? 'selected' : ''}>Internal</option>
        </select>
      </div>
      <div class="field"><label>Priority</label>
        <select id="tk-priority">
          ${['Low', 'Medium', 'High', 'Critical'].map((p) => `<option value="${p}" ${(data.priority || 'Medium') === p ? 'selected' : ''}>${p}</option>`).join('')}
        </select>
      </div>
    </div>
    <div class="field"><label>Location</label><input id="tk-location" value="${esc(data.location || '')}"></div>
    <div class="field"><label>Description</label><textarea id="tk-description" rows="3">${esc(data.description || '')}</textarea></div>
    <div class="grid2">
      <div class="field"><label>Status</label>
        <select id="tk-status">
          ${['Open', 'In Progress', 'Resolved', 'Closed'].map((s) => `<option value="${s}" ${(data.status || 'Open') === s ? 'selected' : ''}>${s}</option>`).join('')}
        </select>
      </div>
      <div class="field"><label>Reported By</label><input id="tk-reported-by" value="${esc(data.reported_by || '')}"></div>
    </div>
    <div class="field"><label>Date Reported</label><input id="tk-date-reported" type="date" value="${data.date_reported || ''}"></div>
    <div class="field"><label>Root Cause (required to close)</label><textarea id="tk-root-cause" rows="2">${esc(data.root_cause || '')}</textarea></div>
    <div class="modal-actions">
      <button type="button" class="btn-sm" onclick="App.closeModal()">Cancel</button>
      <button type="submit" class="btn btn-orange">Save</button>
    </div>
  </form>
`);
