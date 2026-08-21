import { STATE, loadData, invalidate, toast, setState, openModal, closeModal } from '../state.js';
import { registerModal, loadingCard } from '../modals.js';
import { listScreenReports, updateScreenReport, deleteScreenReport } from '../data/screenReports.js';
import { listAssetInventory } from '../data/assetsInventory.js';
import { listContractors } from '../data/contractors.js';
import { canEdit, canDelete } from '../auth.js';
import { esc, fmtRelativeTime } from '../lib/format.js';
import { logAudit } from '../lib/audit.js';
import { supabase } from '../supabaseClient.js';

function contractorLabel(contractors, id) {
  const c = contractors.find((x) => x.id === id);
  if (!c) return '';
  return c.company && c.company !== c.name ? `${c.name} (${c.company})` : c.name;
}

function statusBadge(status) {
  const map = { New: 'b-red', 'Ticket Created': 'b-blue', Resolved: 'b-green', Dismissed: 'b-gray' };
  return `<span class="badge ${map[status] || 'b-blue'}">${esc(status)}</span>`;
}

export function renderScreenReports() {
  const reports = loadData('screenReports', listScreenReports);
  const assetInventory = loadData('assetInventory', listAssetInventory);
  const contractors = loadData('contractorsForScreenReports', listContractors);
  if (reports === null || assetInventory === null || contractors === null) return loadingCard();
  if (reports?.__error) return loadingCard(reports.__error);
  if (assetInventory?.__error) return loadingCard(assetInventory.__error);

  const editOk = canEdit('screenReports');
  const deleteOk = canDelete('screenReports');
  const assetById = new Map(assetInventory.map((a) => [a.id, a]));

  const newCount = reports.filter((r) => r.status === 'New').length;

  const rows = reports.map((r) => {
    const asset = assetById.get(r.asset_id);
    const contractor = asset?.contractor_id ? contractorLabel(contractors, asset.contractor_id) : '';
    return `<tr>
      <td><b>${esc(asset?.name || 'Unknown screen')}</b><div class="small muted">${esc(asset?.venue || '-')}${asset?.location ? ` &middot; ${esc(asset.location)}` : ''}</div></td>
      <td class="small">${esc(r.description)}${r.reporter_name ? `<div class="small muted">- ${esc(r.reporter_name)}</div>` : ''}</td>
      <td>${(r.media_paths || []).length ? `<button class="btn-sm" onclick="App.viewScreenReportMedia('${r.id}')">View (${r.media_paths.length})</button>` : '<span class="small muted">-</span>'}</td>
      <td class="small">${esc(contractor || '-')}</td>
      <td>${statusBadge(r.status)}</td>
      <td class="small">${esc(fmtRelativeTime(r.created_at))}</td>
      <td style="white-space:nowrap;">
        ${editOk && r.status !== 'Ticket Created' ? `<button class="btn-sm" onclick="App.createTicketFromScreenReport('${r.id}')">Create Ticket</button>` : ''}
        ${deleteOk ? `<button class="btn-sm" onclick="App.removeScreenReport('${r.id}')">Delete</button>` : ''}
      </td>
    </tr>`;
  }).join('') || `<tr><td colspan="7"><div class="empty">No screen issue reports yet - they'll show up here as soon as someone scans a QR code and reports a problem.</div></td></tr>`;

  return `
    <div class="kpi-row" style="margin-bottom:14px;">
      <div class="kpi"><div class="label">Total Reports</div><div class="value">${reports.length}</div></div>
      <div class="kpi"><div class="label">New</div><div class="value" style="color:${newCount ? '#c0392b' : 'inherit'};">${newCount}</div></div>
    </div>
    <div class="card">
      <div class="card-head"><h3>Screen Issue Reports</h3><div class="desc">Submitted by scanning the QR code stuck on a physical screen (Asset Inventory &gt; QR Code) - no login needed on their end. Create a ticket directly from a report once you've reviewed it.</div></div>
      <div style="max-height:600px;overflow-y:auto;overflow-x:auto;">
        <table>
          <thead><tr><th>Screen</th><th>Report</th><th>Media</th><th>Contractor</th><th>Status</th><th>Reported</th><th></th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </div>
  `;
}

export async function createTicketFromScreenReport(reportId) {
  const reports = STATE.pageData.screenReports?.data || [];
  const assetInventory = STATE.pageData.assetInventory?.data || [];
  const contractors = STATE.pageData.contractorsForScreenReports?.data || [];
  const report = reports.find((r) => r.id === reportId);
  if (!report) return;
  const asset = assetInventory.find((a) => a.id === report.asset_id);
  const contractor = asset?.contractor_id ? contractors.find((c) => c.id === asset.contractor_id) : null;
  const contractorLine = contractor
    ? `\n\nContractor: ${contractor.name}${contractor.company && contractor.company !== contractor.name ? ` (${contractor.company})` : ''}${contractor.emails?.length ? ` - ${contractor.emails.join(', ')}` : ''}${contractor.phone ? ` - ${contractor.phone}` : ''}`
    : '';
  openModal('ticket', {
    title: `${asset?.name || 'Screen'} - Reported Issue`,
    location: asset?.venue || '',
    asset_inv_id: asset?.id || null,
    description: `${report.description}${report.reporter_name ? ` (reported by ${report.reporter_name})` : ''}${contractorLine}`,
    type: 'Issue',
    date_reported: new Date().toISOString().slice(0, 10),
    status: 'Open',
    __screenReportId: reportId,
  });
}

export async function removeScreenReport(id) {
  if (!confirm('Delete this screen report? This cannot be undone.')) return;
  try {
    await deleteScreenReport(id);
    await logAudit('Delete screen report', id);
    invalidate('screenReports');
    toast('Report deleted');
    setState({});
  } catch (e) { toast(e.message || 'Failed to delete report', 'error'); }
}

export function viewScreenReportMedia(reportId) {
  openModal('screenReportMedia', { reportId });
  loadScreenReportMedia(reportId);
}

registerModal('screenReportMedia', (data) => {
  const reports = STATE.pageData.screenReports?.data || [];
  const report = reports.find((r) => r.id === data.reportId);
  const paths = report?.media_paths || [];
  return `
    <h3>Attached Media</h3>
    <div id="srm-media" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:10px;">
      ${paths.map((_, i) => `<div id="srm-item-${i}" class="small muted">Loading...</div>`).join('')}
    </div>
    <div class="modal-actions"><button class="btn-sm" onclick="App.closeModal()">Close</button></div>
  `;
});

// Signed URLs (attachments bucket is private) are fetched fresh each time the modal opens rather
// than stored - they expire, and there's no reason to keep re-signing ones nobody's looking at.
export async function loadScreenReportMedia(reportId) {
  const reports = STATE.pageData.screenReports?.data || [];
  const report = reports.find((r) => r.id === reportId);
  const paths = report?.media_paths || [];
  await Promise.all(paths.map(async (path, i) => {
    const el = document.getElementById(`srm-item-${i}`);
    if (!el) return;
    try {
      const { data, error } = await supabase.storage.from('attachments').createSignedUrl(path, 3600);
      if (error) throw error;
      const isVideo = /\.(mp4|mov|webm|avi|mkv)$/i.test(path);
      el.outerHTML = isVideo
        ? `<video id="srm-item-${i}" src="${data.signedUrl}" controls style="width:100%;border-radius:8px;"></video>`
        : `<a id="srm-item-${i}" href="${data.signedUrl}" target="_blank" rel="noopener"><img src="${data.signedUrl}" style="width:100%;border-radius:8px;object-fit:cover;max-height:160px;"></a>`;
    } catch (e) {
      if (el) el.textContent = 'Failed to load';
    }
  }));
}
