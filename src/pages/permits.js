import { STATE, loadData, invalidate, openModal, closeModal, toast, setState } from '../state.js';
import { loadingCard, registerModal } from '../modals.js';
import { canAdd, canEdit, canDelete, canExportArea, isAdmin } from '../auth.js';
import { listPermits, savePermit, deletePermit, permitStatus } from '../data/permits.js';
import { logAudit } from '../lib/audit.js';
import { esc, fmtDate } from '../lib/format.js';
import { exportToCsv } from '../lib/csv.js';

const STATUS_BADGE = { Active: 'b-green', 'Expiring Soon': 'b-amber', Expired: 'b-red' };

export function renderPermits() {
  const permits = loadData('permits', listPermits);
  if (permits === null) return loadingCard();
  if (permits?.__error) return loadingCard(permits.__error);

  const rows = permits.map((p) => {
    const status = permitStatus(p);
    return `
      <tr>
        <td>${esc(p.title)}</td>
        <td>${esc(p.type || '-')}</td>
        <td>${esc(p.location || '-')}</td>
        <td>${fmtDate(p.expiry_date)}</td>
        <td><span class="badge ${STATUS_BADGE[status]}">${status}</span></td>
        <td>
          ${canEdit('permits') ? `<button class="btn-sm" onclick="App.editPermit('${p.id}')">Edit</button>` : ''}
          ${canDelete('permits') ? `<button class="btn-sm" onclick="App.removePermit('${p.id}')">Delete</button>` : ''}
        </td>
      </tr>
    `;
  }).join('');

  return `
    <div class="toolbar">
      <div class="tabs"><div class="tab active">All Permits (${permits.length})</div></div>
      <div class="toolbar-actions">
        ${canExportArea('permits') ? `<button class="btn-sm" onclick="App.exportPermitsCsv()">Export CSV</button>` : ''}
        ${isAdmin() ? `<button class="btn-sm" onclick="App.openBulkImport('permits')">Bulk Import</button>` : ''}
        ${canAdd('permits') ? `<button class="btn btn-orange" onclick="App.editPermit(null)">+ Add Permit</button>` : ''}
      </div>
    </div>
    <div class="card">
      ${permits.length === 0 ? '<div class="empty">No permits yet.</div>' : `
        <table>
          <thead><tr><th>Title</th><th>Type</th><th>Location</th><th>Expiry</th><th>Status</th><th></th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      `}
    </div>
  `;
}

export function exportPermitsCsv() {
  const permits = STATE.pageData.permits?.data || [];
  exportToCsv('permits.csv', [
    { label: 'Title', value: (p) => p.title }, { label: 'Type', value: (p) => p.type },
    { label: 'Location', value: (p) => p.location }, { label: 'Issued By', value: (p) => p.issued_by },
    { label: 'Issue Date', value: (p) => p.issue_date }, { label: 'Expiry Date', value: (p) => p.expiry_date },
    { label: 'Status', value: (p) => permitStatus(p) }, { label: 'Notes', value: (p) => p.notes },
  ], permits);
}

export function editPermit(id) {
  const permits = STATE.pageData.permits?.data || [];
  const row = id ? permits.find((p) => p.id === id) : null;
  openModal('permit', row || {});
}

export async function removePermit(id) {
  if (!confirm('Move this permit to the Recycle Bin?')) return;
  try {
    await deletePermit(id);
    await logAudit('Delete permit', id);
    invalidate('permits');
    toast('Permit deleted');
    setState({});
  } catch (e) {
    toast(e.message, 'error');
  }
}

export async function savePermitForm(event) {
  event.preventDefault();
  const id = document.getElementById('pm-id').value || null;
  const fileInput = document.getElementById('pm-file');
  const row = {
    id,
    title: document.getElementById('pm-title').value.trim(),
    type: document.getElementById('pm-type').value.trim(),
    location: document.getElementById('pm-location').value.trim(),
    issuedBy: document.getElementById('pm-issued-by').value.trim(),
    issueDate: document.getElementById('pm-issue-date').value || null,
    expiryDate: document.getElementById('pm-expiry-date').value || null,
    notes: document.getElementById('pm-notes').value.trim(),
  };
  try {
    await savePermit(row, fileInput.files[0] || null);
    await logAudit(id ? 'Edit permit' : 'Add permit', row.title);
    invalidate('permits');
    closeModal();
    toast('Permit saved');
  } catch (e) {
    toast(e.message, 'error');
  }
}

registerModal('permit', (data) => `
  <h3>${data.id ? 'Edit' : 'Add'} Permit</h3>
  <form onsubmit="App.savePermitForm(event)">
    <input type="hidden" id="pm-id" value="${esc(data.id || '')}">
    <div class="field"><label>Title</label><input id="pm-title" value="${esc(data.title || '')}" required></div>
    <div class="grid2">
      <div class="field"><label>Type</label><input id="pm-type" value="${esc(data.type || '')}" placeholder="Municipality / Civil Defense / Trade License"></div>
      <div class="field"><label>Location</label><input id="pm-location" value="${esc(data.location || '')}"></div>
    </div>
    <div class="grid2">
      <div class="field"><label>Issued By</label><input id="pm-issued-by" value="${esc(data.issued_by || '')}"></div>
      <div class="field"><label>Issue Date</label><input id="pm-issue-date" type="date" value="${data.issue_date || ''}"></div>
    </div>
    <div class="field"><label>Expiry Date</label><input id="pm-expiry-date" type="date" value="${data.expiry_date || ''}"></div>
    <div class="field"><label>Document</label><input id="pm-file" type="file" accept="application/pdf,image/*">
      ${data.document_filename ? `<div class="file-chip">${esc(data.document_filename)}</div>` : ''}
    </div>
    <div class="field"><label>Notes</label><textarea id="pm-notes" rows="2">${esc(data.notes || '')}</textarea></div>
    <div class="modal-actions">
      <button type="button" class="btn-sm" onclick="App.closeModal()">Cancel</button>
      <button type="submit" class="btn btn-orange">Save</button>
    </div>
  </form>
`);
