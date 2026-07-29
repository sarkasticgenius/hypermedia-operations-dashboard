import { STATE, loadData, invalidate, openModal, closeModal, toast, setState } from '../state.js';
import { loadingCard, registerModal } from '../modals.js';
import { canEdit } from '../auth.js';
import {
  listDashboardSections, addDashboardSection, deleteDashboardSection,
  addDashboardLink, saveDashboardLink, deleteDashboardLink,
} from '../data/dashboards.js';
import { logAudit } from '../lib/audit.js';
import { esc } from '../lib/format.js';

export function renderDashboards() {
  const sections = loadData('dashboardSections', listDashboardSections);
  if (sections === null) return loadingCard();
  if (sections?.__error) return loadingCard(sections.__error);

  const activeId = STATE.activeDashboardId || sections.flatMap((s) => s.dashboards || [])[0]?.id;
  let activeDash = null;
  for (const s of sections) {
    const found = (s.dashboards || []).find((d) => d.id === activeId);
    if (found) { activeDash = found; break; }
  }

  const editable = canEdit('dashboards');

  const listHtml = sections.map((s) => `
    <div class="dash-section">
      <div class="dash-section-title">${esc(s.name)} ${editable ? `<button class="link-btn" style="float:right;" onclick="App.addDashLink('${s.id}')">+ Link</button>` : ''}</div>
      ${(s.dashboards || []).map((d) => `
        <div class="dash-item ${d.id === activeId ? 'active' : ''}" onclick="App.setActiveDashboard('${d.id}')">
          <span>${esc(d.name)}</span>
          ${editable ? `<span>
            <button class="link-btn" onclick="event.stopPropagation();App.editDashLink('${d.id}','${s.id}')">Edit</button>
            <button class="link-btn" onclick="event.stopPropagation();App.removeDashLink('${d.id}')">Delete</button>
          </span>` : ''}
        </div>
      `).join('') || '<div class="empty small">No links yet.</div>'}
    </div>
  `).join('');

  return `
    <div class="dash-layout">
      <div class="dash-list">${listHtml}</div>
      <div class="dash-frame-wrap">
        <div class="dash-frame-head">
          <span>${activeDash ? esc(activeDash.name) : 'Select a dashboard'}</span>
        </div>
        ${activeDash ? `<iframe class="dash-iframe" src="${esc(activeDash.url)}"></iframe>` : '<div class="empty">Pick a dashboard from the list.</div>'}
      </div>
    </div>
  `;
}

export function setActiveDashboard(id) {
  setState({ activeDashboardId: id });
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
  if (!confirm('Delete this dashboard link?')) return;
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
