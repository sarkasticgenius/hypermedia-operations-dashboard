import { STATE, loadData, invalidate, openModal, closeModal, toast, setState } from '../state.js';
import { loadingCard, registerModal } from '../modals.js';
import { canAdd, canEdit, canDelete, canExportArea, isAdmin } from '../auth.js';
import { listMetroPics, saveMetroPic, deleteMetroPic, renewMetroPic, metroPicStatus } from '../data/metroPics.js';
import { logAudit } from '../lib/audit.js';
import { esc, fmtDate, daysUntilInfo } from '../lib/format.js';
import { exportToExcel } from '../lib/excelExport.js';
import { sortTh, applySort } from '../lib/sortableTable.js';

const STATUS_BADGE = { Active: 'b-green', 'Expiring Soon': 'b-amber', Expired: 'b-red' };

export function renderMetroPic() {
  const pics = loadData('metroPics', listMetroPics);
  if (pics === null) return loadingCard();
  if (pics?.__error) return loadingCard(pics.__error);

  const sorted = applySort(pics, 'metroPics', {
    station: (m) => m.station || '', picName: (m) => m.pic_name || '', phone: (m) => m.phone || '',
    validityStart: (m) => m.validity_start || '', validityEnd: (m) => m.validity_end || '',
    status: (m) => metroPicStatus(m), daysToExpire: (m) => m.validity_end || '',
  });

  const rows = sorted.map((m) => {
    const status = metroPicStatus(m);
    const di = daysUntilInfo(m.validity_end);
    return `
      <tr>
        <td>${esc(m.station)}</td>
        <td>${esc(m.pic_name || '-')}</td>
        <td>${esc(m.phone || '-')}</td>
        <td>${fmtDate(m.validity_start)}</td>
        <td>${fmtDate(m.validity_end)}</td>
        <td class="tcenter"><span class="badge ${di.overdue ? 'b-red' : di.urgent ? 'b-amber' : 'b-gray'}">${esc(di.text)}</span></td>
        <td class="tcenter"><span class="badge ${STATUS_BADGE[status] || 'b-gray'}">${status}</span></td>
        <td>
          ${canEdit('metroPic') ? `<button class="btn-sm" onclick="App.editMetroPic('${m.id}')">Edit</button>` : ''}
          ${canEdit('metroPic') ? `<button class="btn-sm" onclick="App.renewMetroPicRow('${m.id}')">Renew</button>` : ''}
          ${canDelete('metroPic') ? `<button class="btn-sm" onclick="App.removeMetroPic('${m.id}')">Delete</button>` : ''}
        </td>
      </tr>
    `;
  }).join('');

  return `
    <div class="toolbar">
      <div class="tabs"><div class="tab active">All PICs (${pics.length})</div></div>
      <div class="toolbar-actions">
        ${canExportArea('metroPic') ? `<button class="btn-sm" onclick="App.exportMetroPicExcel()">Export</button>` : ''}
        ${isAdmin() ? `<button class="btn-sm" onclick="App.openBulkImport('metroPic')">Bulk Import</button>` : ''}
        ${canAdd('metroPic') ? `<button class="btn btn-orange" onclick="App.editMetroPic(null)">+ Add PIC</button>` : ''}
      </div>
    </div>
    <div class="card">
      ${pics.length === 0 ? '<div class="empty">No Metro PICs yet.</div>' : `
        <table>
          <thead><tr>${sortTh('metroPics', 'station', 'Company Name')}${sortTh('metroPics', 'picName', 'PIC Name')}${sortTh('metroPics', 'phone', 'Phone')}${sortTh('metroPics', 'validityStart', 'Valid From')}${sortTh('metroPics', 'validityEnd', 'Valid Until')}${sortTh('metroPics', 'daysToExpire', 'Days to Expire', null, 'center')}${sortTh('metroPics', 'status', 'Status', null, 'center')}<th></th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      `}
    </div>
  `;
}

export async function exportMetroPicExcel() {
  const pics = STATE.pageData.metroPics?.data || [];
  await exportToExcel('metro-pic.xlsx', [
    { label: 'Company Name', value: (m) => m.station }, { label: 'PIC Name', value: (m) => m.pic_name },
    { label: 'Designation', value: (m) => m.designation }, { label: 'Phone', value: (m) => m.phone },
    { label: 'Email', value: (m) => m.email }, { label: 'Validity Start', value: (m) => m.validity_start },
    { label: 'Validity End', value: (m) => m.validity_end }, { label: 'EID Number', value: (m) => m.eid_number },
  ], pics);
}

export function editMetroPic(id) {
  const pics = STATE.pageData.metroPics?.data || [];
  const row = id ? pics.find((m) => m.id === id) : null;
  openModal('metroPic', row || {});
}

export function renewMetroPicRow(id) {
  const pics = STATE.pageData.metroPics?.data || [];
  const row = pics.find((m) => m.id === id);
  if (row) openModal('metroPicRenew', row);
}

export async function removeMetroPic(id) {
  if (!confirm('Move this PIC record to the Recycle Bin?')) return;
  try {
    await deleteMetroPic(id);
    await logAudit('Delete Metro PIC', id);
    invalidate('metroPics');
    toast('PIC deleted');
    setState({});
  } catch (e) {
    toast(e.message, 'error');
  }
}

export async function saveMetroPicForm(event) {
  event.preventDefault();
  const id = document.getElementById('mp-id').value || null;
  const fileInput = document.getElementById('mp-file');
  const row = {
    id,
    station: document.getElementById('mp-station').value.trim(),
    picName: document.getElementById('mp-name').value.trim(),
    designation: document.getElementById('mp-designation').value.trim(),
    phone: document.getElementById('mp-phone').value.trim(),
    email: document.getElementById('mp-email').value.trim(),
    validityStart: document.getElementById('mp-start').value || null,
    validityEnd: document.getElementById('mp-end').value || null,
    eidNumber: document.getElementById('mp-eid').value.trim(),
    notes: document.getElementById('mp-notes').value.trim(),
  };
  try {
    await saveMetroPic(row, fileInput.files[0] || null);
    await logAudit(id ? 'Edit Metro PIC' : 'Add Metro PIC', row.station);
    invalidate('metroPics');
    closeModal();
    toast('PIC saved');
  } catch (e) {
    toast(e.message, 'error');
  }
}

export async function saveMetroPicRenewal(event) {
  event.preventDefault();
  const id = document.getElementById('mpr-id').value;
  const pics = STATE.pageData.metroPics?.data || [];
  const current = pics.find((m) => m.id === id);
  const next = {
    validityStart: document.getElementById('mpr-start').value || null,
    validityEnd: document.getElementById('mpr-end').value || null,
    picName: document.getElementById('mpr-name').value.trim(),
    designation: current.designation, phone: current.phone, email: current.email,
    eidNumber: current.eid_number, notes: current.notes,
  };
  try {
    await renewMetroPic(id, current, next, STATE.user.name);
    await logAudit('Renew Metro PIC', current.station);
    invalidate('metroPics');
    closeModal();
    toast('PIC renewed');
  } catch (e) {
    toast(e.message, 'error');
  }
}

registerModal('metroPic', (data) => `
  <h3>${data.id ? 'Edit' : 'Add'} Metro PIC</h3>
  <form onsubmit="App.saveMetroPicForm(event)">
    <input type="hidden" id="mp-id" value="${esc(data.id || '')}">
    <div class="field"><label>Company Name</label><input id="mp-station" value="${esc(data.station || '')}" required></div>
    <div class="grid2">
      <div class="field"><label>PIC Name</label><input id="mp-name" value="${esc(data.pic_name || '')}"></div>
      <div class="field"><label>Designation</label><input id="mp-designation" value="${esc(data.designation || '')}"></div>
    </div>
    <div class="grid2">
      <div class="field"><label>Phone</label><input id="mp-phone" value="${esc(data.phone || '')}"></div>
      <div class="field"><label>Email</label><input id="mp-email" type="email" value="${esc(data.email || '')}"></div>
    </div>
    <div class="grid2">
      <div class="field"><label>Validity Start</label><input id="mp-start" type="date" value="${data.validity_start || ''}"></div>
      <div class="field"><label>Validity End</label><input id="mp-end" type="date" value="${data.validity_end || ''}"></div>
    </div>
    <div class="field"><label>Emirates ID Number</label><input id="mp-eid" value="${esc(data.eid_number || '')}"></div>
    <div class="field"><label>Emirates ID Copy</label><input id="mp-file" type="file" accept="application/pdf,image/*">
      ${data.eid_document_filename ? `<div class="file-chip">${esc(data.eid_document_filename)}</div>` : ''}
    </div>
    <div class="field"><label>Notes</label><textarea id="mp-notes" rows="2">${esc(data.notes || '')}</textarea></div>
    <div class="modal-actions">
      <button type="button" class="btn-sm" onclick="App.closeModal()">Cancel</button>
      <button type="submit" class="btn btn-orange">Save</button>
    </div>
  </form>
`);

registerModal('metroPicRenew', (data) => `
  <h3>Renew PIC - ${esc(data.station)}</h3>
  <p class="small muted">This snapshots the current PIC details into renewal history, then updates validity to the new dates.</p>
  <form onsubmit="App.saveMetroPicRenewal(event)">
    <input type="hidden" id="mpr-id" value="${esc(data.id || '')}">
    <div class="field"><label>PIC Name</label><input id="mpr-name" value="${esc(data.pic_name || '')}"></div>
    <div class="grid2">
      <div class="field"><label>New Validity Start</label><input id="mpr-start" type="date" required></div>
      <div class="field"><label>New Validity End</label><input id="mpr-end" type="date" required></div>
    </div>
    <div class="modal-actions">
      <button type="button" class="btn-sm" onclick="App.closeModal()">Cancel</button>
      <button type="submit" class="btn btn-orange">Renew</button>
    </div>
  </form>
`);
