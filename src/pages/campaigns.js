import { STATE, loadData, invalidate, openModal, closeModal, toast, setState } from '../state.js';
import { loadingCard, registerModal } from '../modals.js';
import { canAdd, canEdit, canDelete, canExportArea, isAdmin } from '../auth.js';
import { listCampaigns, saveCampaign, deleteCampaign } from '../data/campaigns.js';
import { logAudit } from '../lib/audit.js';
import { esc, fmtDate, fmtMoney } from '../lib/format.js';
import { exportToExcel } from '../lib/excelExport.js';
import { brandLogoTag } from '../lib/brandLogo.js';
import { sortTh, applySort } from '../lib/sortableTable.js';

const STATUS_BADGE = { Scheduled: 'b-blue', Online: 'b-green', Offline: 'b-red', Ended: 'b-gray' };

export function renderCampaigns() {
  const campaigns = loadData('campaigns', listCampaigns);
  if (campaigns === null) return loadingCard();
  if (campaigns?.__error) return loadingCard(campaigns.__error);

  const sorted = applySort(campaigns, 'campaigns', {
    name: (c) => c.name || '', client: (c) => c.client || '', dates: (c) => c.start_date || '',
    budget: (c) => c.budget || 0, status: (c) => c.status || '',
  });

  const rows = sorted.map((c) => `
    <tr>
      <td>${esc(c.name)}</td>
      <td>${c.client ? `${brandLogoTag(c.client, 18)} ` : ''}${esc(c.client || '-')}</td>
      <td>${fmtDate(c.start_date)} - ${fmtDate(c.end_date)}</td>
      <td>${fmtMoney(c.budget)}</td>
      <td class="tcenter"><span class="badge ${STATUS_BADGE[c.status] || 'b-gray'}">${esc(c.status)}</span></td>
      <td>
        ${canEdit('campaigns') ? `<button class="btn-sm" onclick="App.editCampaign('${c.id}')">Edit</button>` : ''}
        ${canDelete('campaigns') ? `<button class="btn-sm" onclick="App.removeCampaign('${c.id}')">Delete</button>` : ''}
      </td>
    </tr>
  `).join('');

  return `
    <div class="toolbar">
      <div class="tabs"><div class="tab active">All Campaigns (${campaigns.length})</div></div>
      <div class="toolbar-actions">
        ${canExportArea('campaigns') ? `<button class="btn-sm" onclick="App.exportCampaignsExcel()">Export</button>` : ''}
        ${isAdmin() ? `<button class="btn-sm" onclick="App.openBulkImport('campaigns')">Bulk Import</button>` : ''}
        ${canAdd('campaigns') ? `<button class="btn btn-orange" onclick="App.editCampaign(null)">+ New Campaign</button>` : ''}
      </div>
    </div>
    <div class="card">
      ${campaigns.length === 0 ? '<div class="empty">No campaigns yet.</div>' : `
        <table>
          <thead><tr>${sortTh('campaigns', 'name', 'Name')}${sortTh('campaigns', 'client', 'Client')}${sortTh('campaigns', 'dates', 'Dates')}${sortTh('campaigns', 'budget', 'Budget')}${sortTh('campaigns', 'status', 'Status', null, 'center')}<th></th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      `}
    </div>
  `;
}

export async function exportCampaignsExcel() {
  const campaigns = STATE.pageData.campaigns?.data || [];
  await exportToExcel('campaigns.xlsx', [
    { label: 'Name', value: (c) => c.name }, { label: 'Client', value: (c) => c.client },
    { label: 'Locations', value: (c) => c.locations }, { label: 'Start Date', value: (c) => c.start_date },
    { label: 'End Date', value: (c) => c.end_date }, { label: 'Budget', value: (c) => c.budget },
    { label: 'Status', value: (c) => c.status }, { label: 'Notes', value: (c) => c.notes },
  ], campaigns);
}

export function editCampaign(id) {
  const campaigns = STATE.pageData.campaigns?.data || [];
  const row = id ? campaigns.find((c) => c.id === id) : null;
  openModal('campaign', row || {});
}

export async function removeCampaign(id) {
  if (!confirm('Move this campaign to the Recycle Bin?')) return;
  try {
    await deleteCampaign(id);
    await logAudit('Delete campaign', id);
    invalidate('campaigns');
    toast('Campaign deleted');
    setState({});
  } catch (e) {
    toast(e.message, 'error');
  }
}

export async function saveCampaignForm(event) {
  event.preventDefault();
  const id = document.getElementById('cm-id').value || null;
  const row = {
    id,
    name: document.getElementById('cm-name').value.trim(),
    client: document.getElementById('cm-client').value.trim(),
    locations: document.getElementById('cm-locations').value.trim(),
    startDate: document.getElementById('cm-start').value || null,
    endDate: document.getElementById('cm-end').value || null,
    budget: Number(document.getElementById('cm-budget').value || 0),
    status: document.getElementById('cm-status').value,
    notes: document.getElementById('cm-notes').value.trim(),
  };
  try {
    await saveCampaign(row);
    await logAudit(id ? 'Edit campaign' : 'Add campaign', row.name);
    invalidate('campaigns');
    closeModal();
    toast('Campaign saved');
  } catch (e) {
    toast(e.message, 'error');
  }
}

registerModal('campaign', (data) => `
  <h3>${data.id ? 'Edit' : 'New'} Campaign</h3>
  <form onsubmit="App.saveCampaignForm(event)">
    <input type="hidden" id="cm-id" value="${esc(data.id || '')}">
    <div class="field"><label>Name</label><input id="cm-name" value="${esc(data.name || '')}" required></div>
    <div class="grid2">
      <div class="field"><label>Client</label><input id="cm-client" value="${esc(data.client || '')}"></div>
      <div class="field"><label>Budget (AED)</label><input id="cm-budget" type="number" step="0.01" value="${data.budget || 0}"></div>
    </div>
    <div class="field"><label>Locations (comma separated)</label><input id="cm-locations" value="${esc(data.locations || '')}"></div>
    <div class="grid2">
      <div class="field"><label>Start Date</label><input id="cm-start" type="date" value="${data.start_date || ''}" required></div>
      <div class="field"><label>End Date</label><input id="cm-end" type="date" value="${data.end_date || ''}" required></div>
    </div>
    <div class="field"><label>Status</label>
      <select id="cm-status">
        ${['Scheduled', 'Online', 'Offline', 'Ended'].map((s) => `<option value="${s}" ${(data.status || 'Scheduled') === s ? 'selected' : ''}>${s}</option>`).join('')}
      </select>
    </div>
    <div class="field"><label>Notes</label><textarea id="cm-notes" rows="2">${esc(data.notes || '')}</textarea></div>
    <div class="modal-actions">
      <button type="button" class="btn-sm" onclick="App.closeModal()">Cancel</button>
      <button type="submit" class="btn btn-orange">Save</button>
    </div>
  </form>
`);
