import { STATE, loadData, invalidate, openModal, closeModal, toast, setState } from '../state.js';
import { loadingCard, registerModal } from '../modals.js';
import { canEdit } from '../auth.js';
import { NAV_GROUP_LABELS } from '../shell.js';
import {
  listDashboardSections, addDashboardLink, saveDashboardLink, deleteDashboardLink,
} from '../data/dashboards.js';
import { logAudit } from '../lib/audit.js';
import { esc } from '../lib/format.js';

// The section/link list already lives in the sidebar under Workspace (Maintenance/Digital
// Campaigns/pDOOH panels), so this page just shows the selected link's live view - no
// duplicate list here.
export function renderDashboards() {
  const allSections = loadData('dashboardSections', listDashboardSections);
  if (allSections === null) return loadingCard();
  if (allSections?.__error) return loadingCard(allSections.__error);

  const admin = canEdit('dashboards');

  if (!allSections.length) {
    return `<div class="card"><div class="empty">No dashboard links yet.${admin ? ' Configure one from the sidebar.' : ' Ask an Admin to add one.'}</div></div>`;
  }

  let activeSection = allSections.find((s) => s.id === STATE.activeDashSection);
  if (!activeSection) activeSection = allSections.find((s) => (s.nav_group || 'dashboards') === 'dashboards') || allSections[0];

  let activeId = STATE.activeDashboard;
  let active = activeId ? (activeSection.dashboards || []).find((d) => d.id === activeId) : null;
  if (!active) active = (activeSection.dashboards || [])[0] || null;

  const groupTitle = NAV_GROUP_LABELS[activeSection.nav_group || 'dashboards'] || 'Dashboards';

  // A plain block wouldn't give .dash-frame-wrap's flex:1 anything to grow against - .content
  // itself stretches to fill the page (flex:1 under .main's column), but isn't a flex container,
  // so without this wrapper the iframe area only sized itself to its own content, leaving a gap
  // below whenever the page was taller than the iframe wanted to be.
  return `<div style="display:flex;flex-direction:column;height:100%;">
    <div class="banner" style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;flex-shrink:0;">
      <span>Links are managed from the sidebar under Workspace.${admin ? ' Click Edit next to a link there to update its name or URL.' : ''} If a link shows blank, its site may block embedding - use "Open in new tab" as a fallback.</span>
      ${admin ? `<button class="btn-sm" style="white-space:nowrap;" onclick='App.addDashLink("${activeSection.id}")'>+ Add Link to ${esc(groupTitle)}</button>` : ''}
    </div>
    <div class="dash-frame-wrap">
      ${active && active.url ? `
        <div class="dash-frame-head">
          <b>${esc(active.name)}</b>
          <a href="${esc(active.url)}" target="_blank" rel="noopener" class="link-btn">Open in new tab</a>
        </div>
        <iframe class="dash-iframe" src="${esc(active.url)}" loading="lazy" referrerpolicy="no-referrer-when-downgrade"></iframe>
      ` : active ? `<div class="empty">No URL set for "${esc(active.name)}" yet.${admin ? ' Click Edit in the sidebar to add one.' : ''}</div>`
        : `<div class="empty">No links added to ${esc(groupTitle)} yet.${admin ? ' Use "+ Add Link" above.' : ''}</div>`}
    </div>
  </div>`;
}

export function addDashLink(sectionId) {
  openModal('dashLink', { sectionId });
}

export function editDashLink(id, sectionId) {
  const sections = STATE.pageData.dashboardSections?.data || [];
  const section = sections.find((s) => s.id === sectionId);
  const link = section?.dashboards.find((d) => d.id === id);
  openModal('dashLink', { ...link, sectionId, id });
}

export async function removeDashLink(id) {
  if (!confirm('Move this dashboard link to the Recycle Bin?')) return;
  try {
    await deleteDashboardLink(id);
    await logAudit('Delete dashboard link', id);
    invalidate('dashboardSections');
    toast('Link deleted');
    setState({});
  } catch (e) { toast(e.message, 'error'); }
}

export async function saveDashLinkForm(event) {
  event.preventDefault();
  const id = document.getElementById('dl-id').value || null;
  const sectionId = document.getElementById('dl-section-id').value;
  const name = document.getElementById('dl-name').value.trim();
  const url = document.getElementById('dl-url').value.trim();
  try {
    if (id) await saveDashboardLink(id, name, url);
    else await addDashboardLink(sectionId, name, url);
    await logAudit(id ? 'Edit dashboard link' : 'Add dashboard link', name);
    invalidate('dashboardSections');
    closeModal();
    toast('Link saved');
    setState({ activeDashSection: sectionId });
  } catch (e) { toast(e.message, 'error'); }
}

registerModal('dashLink', (data) => `
  <h3>${data.id ? 'Edit' : 'Add'} Dashboard Link</h3>
  <form onsubmit="App.saveDashLinkForm(event)">
    <input type="hidden" id="dl-id" value="${esc(data.id || '')}">
    <input type="hidden" id="dl-section-id" value="${esc(data.sectionId || '')}">
    <div class="field"><label>Name</label><input id="dl-name" value="${esc(data.name || '')}" required></div>
    <div class="field"><label>URL</label><input id="dl-url" type="url" value="${esc(data.url || '')}" required placeholder="https://..."></div>
    <div class="modal-actions">
      <button type="button" class="btn-sm" onclick="App.closeModal()">Cancel</button>
      <button type="submit" class="btn btn-orange">Save</button>
    </div>
  </form>
`);
