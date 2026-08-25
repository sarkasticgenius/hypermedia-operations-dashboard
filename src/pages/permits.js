import { STATE, loadData, invalidate, openModal, closeModal, toast, setState } from '../state.js';
import { loadingCard, registerModal } from '../modals.js';
import { canAdd, canEdit, canDelete, canExportArea, isAdmin } from '../auth.js';
import { listPermits, savePermit, deletePermit, permitStatus, permitDaysToExpire, permitStatusColor } from '../data/permits.js';
import { logAudit } from '../lib/audit.js';
import { esc, fmtDate, jsAttr } from '../lib/format.js';
import { exportToExcel } from '../lib/excelExport.js';
import { sortTh, applySort } from '../lib/sortableTable.js';
import { getSignedUrl } from '../lib/storage.js';

// Fixed Location options for the Add/Edit Permit form, per ops' own predefined list rather than
// derived from Asset Inventory - Dubai Metro and Pavilions are each one entry covering many
// individual stations/pavilions (Al Furjan South/West, Discovery Gardens, International City,
// Jumeirah Park East/West, etc.) since a permit is never issued per-station/per-pavilion.
const PERMIT_LOCATIONS = [
  'Abu Dhabi Mall', 'Al Hamra Mall', 'Bawabat Al Sharq Mall', 'Burjuman Mall', 'Circle Mall',
  'Dalma Mall', 'Deerfield Mall', 'Dubai Metro', 'Dragon Mart-1', 'Dragon Mart-2',
  'Dubai Festival City', 'Dubai Festival Plaza', 'IBN BATTUTA Mall', 'Pavilions',
  'MARINA MALL-ABU DHABI', 'Mushrif Mall', 'NAKHEEL MALL', 'REEM MALL', 'WAFi Mall', 'EXPO CITY',
];

function daysToExpireLabel(p) {
  const d = permitDaysToExpire(p);
  if (d == null) return '-';
  if (d < 0) return `Expired ${Math.abs(d)}d ago`;
  if (d === 0) return 'Today';
  return `${d}d`;
}

export function renderPermits() {
  const permits = loadData('permits', listPermits);
  if (permits === null) return loadingCard();
  if (permits?.__error) return loadingCard(permits.__error);

  const sorted = applySort(permits, 'permits', {
    location: (p) => p.location || '',
    startDate: (p) => p.issue_date || '',
    expiry: (p) => p.expiry_date || '', daysToExpire: (p) => permitDaysToExpire(p), status: (p) => permitStatus(p),
  });

  const rows = sorted.map((p) => {
    const status = permitStatus(p);
    const color = permitStatusColor(p);
    return `
      <tr>
        <td>${esc(p.location || '-')}</td>
        <td>${p.issue_date ? fmtDate(p.issue_date) : '-'}</td>
        <td>${fmtDate(p.expiry_date)}</td>
        <td class="tcenter"><span class="badge ${color}">${esc(daysToExpireLabel(p))}</span></td>
        <td class="tcenter"><span class="badge ${color}">${status}</span></td>
        <td class="tleft">${p.document_path ? `<span class="file-chip">FILE: ${esc(p.document_filename || 'document')}</span> <a href="#" onclick="App.viewPermitDocument('${jsAttr(p.document_path)}');return false;" class="link-btn" style="font-size:11px;">View</a> <a href="#" onclick="App.downloadPermitDocument('${jsAttr(p.document_path)}','${jsAttr(p.document_filename || 'document')}');return false;" class="link-btn" style="font-size:11px;">Download</a>` : '<span class="muted small">-</span>'}</td>
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
        ${canExportArea('permits') ? `<button class="btn-sm" onclick="App.exportPermitsExcel()">Export</button>` : ''}
        ${isAdmin() ? `<button class="btn-sm" onclick="App.openBulkImport('permits')">Bulk Import</button>` : ''}
        ${canAdd('permits') ? `<button class="btn btn-orange" onclick="App.editPermit(null)">+ Add Permit</button>` : ''}
      </div>
    </div>
    <div class="card">
      ${permits.length === 0 ? '<div class="empty">No permits yet.</div>' : `
        <table>
          <thead><tr>${sortTh('permits', 'location', 'Location')}${sortTh('permits', 'startDate', 'Start Date')}${sortTh('permits', 'expiry', 'Expiry')}${sortTh('permits', 'daysToExpire', 'Days to Expire', null, 'center')}${sortTh('permits', 'status', 'Status', null, 'center')}<th class="tleft">Document</th><th></th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      `}
    </div>
  `;
}

export async function exportPermitsExcel() {
  const permits = STATE.pageData.permits?.data || [];
  await exportToExcel('permits.xlsx', [
    { label: 'Location', value: (p) => p.location }, { label: 'Issued By', value: (p) => p.issued_by },
    { label: 'Issue Date', value: (p) => p.issue_date }, { label: 'Expiry Date', value: (p) => p.expiry_date },
    { label: 'Days to Expire', value: (p) => permitDaysToExpire(p) ?? '' },
    { label: 'Status', value: (p) => permitStatus(p) }, { label: 'Notes', value: (p) => p.notes },
  ], permits);
}

export async function viewPermitDocument(path) {
  try {
    const url = await getSignedUrl(path, 300);
    window.open(url, '_blank');
  } catch (e) { toast(e.message, 'error'); }
}

// Signed URLs point at Supabase Storage (a different origin), where an <a download> attribute is
// silently ignored by the browser - fetching the file into a Blob and downloading that same-origin
// object URL is the only way to force an actual download instead of an in-tab preview.
export async function downloadPermitDocument(path, filename) {
  try {
    const url = await getSignedUrl(path, 300);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Download failed (HTTP ${res.status})`);
    const blob = await res.blob();
    const blobUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = blobUrl;
    a.download = filename || 'document';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(blobUrl);
  } catch (e) { toast(e.message, 'error'); }
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
  const newLocation = document.getElementById('pm-location-new').value.trim();
  const row = {
    id,
    location: newLocation || document.getElementById('pm-location').value.trim(),
    issuedBy: document.getElementById('pm-issued-by').value.trim(),
    issueDate: document.getElementById('pm-issue-date').value || null,
    expiryDate: document.getElementById('pm-expiry-date').value || null,
    notes: document.getElementById('pm-notes').value.trim(),
  };
  try {
    await savePermit(row, fileInput.files[0] || null);
    await logAudit(id ? 'Edit permit' : 'Add permit', row.location || id || 'permit');
    invalidate('permits');
    closeModal();
    toast('Permit saved');
  } catch (e) {
    toast(e.message, 'error');
  }
}

registerModal('permit', (data) => {
  const locationOptions = PERMIT_LOCATIONS;
  const currentLocation = data.location || '';
  return `
  <h3>${data.id ? 'Edit' : 'Add'} Permit</h3>
  <form onsubmit="App.savePermitForm(event)">
    <input type="hidden" id="pm-id" value="${esc(data.id || '')}">
    <div class="field"><label>Location</label>
      <select id="pm-location" onchange="document.getElementById('pm-location-new').value=''">
        <option value="">-</option>
        ${locationOptions.map((v) => `<option value="${esc(v)}" ${currentLocation === v ? 'selected' : ''}>${esc(v)}</option>`).join('')}
        ${currentLocation && !locationOptions.includes(currentLocation) ? `<option value="${esc(currentLocation)}" selected>${esc(currentLocation)}</option>` : ''}
      </select>
      <input id="pm-location-new" placeholder="Or type a new location not listed above" style="margin-top:6px;" oninput="if(this.value)document.getElementById('pm-location').value=''">
    </div>
    <div class="grid2">
      <div class="field"><label>Issued By</label><input id="pm-issued-by" value="${esc(data.issued_by || '')}"></div>
      <div class="field"><label>Issue Date</label><input id="pm-issue-date" type="date" value="${data.issue_date || ''}"></div>
    </div>
    <div class="field"><label>Expiry Date</label><input id="pm-expiry-date" type="date" value="${data.expiry_date || ''}"></div>
    <div class="field"><label>Document</label><input id="pm-file" type="file" accept="application/pdf,image/*">
      ${data.document_path ? `<div class="small" style="margin-top:6px;">Current file: <b>${esc(data.document_filename || 'document')}</b> <a href="#" onclick="App.viewPermitDocument('${jsAttr(data.document_path)}');return false;" class="link-btn">View</a> <a href="#" onclick="App.downloadPermitDocument('${jsAttr(data.document_path)}','${jsAttr(data.document_filename || 'document')}');return false;" class="link-btn">Download</a></div>` : ''}
    </div>
    <div class="field"><label>Notes (title/type/details can go here)</label><textarea id="pm-notes" rows="3">${esc(data.notes || '')}</textarea></div>
    <div class="modal-actions">
      <button type="button" class="btn-sm" onclick="App.closeModal()">Cancel</button>
      <button type="submit" class="btn btn-orange">Save</button>
    </div>
  </form>
`;
});
